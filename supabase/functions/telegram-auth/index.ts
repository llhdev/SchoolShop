// Validates Telegram Mini App initData and upserts the shopper record.
// Called once per Mini App session by the client (no Supabase Auth involved —
// the signed initData IS the proof of identity).
//
// The response also carries `ordersToken`: HMAC-SHA256 hex of the telegram id
// keyed by the shared internal secret. The client sends it to the
// get_orders_by_telegram_id RPC (migration 062) to read its order history —
// a telegram id alone no longer lists orders.
//
// Required secrets (Supabase Dashboard > Edge Functions > Secrets):
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   VERIFY_FUNCTION_SECRET — same value as the 'verify_function_secret'
//     Supabase Vault secret (falls back to TELEGRAM_BOT_TOKEN when unset)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const ORDERS_TOKEN_SECRET = Deno.env.get('VERIFY_FUNCTION_SECRET') ?? BOT_TOKEN;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key instanceof ArrayBuffer ? new Uint8Array(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison for equal-length hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Telegram initData validation: the `hash` field must equal
 * HMAC-SHA256(data_check_string, secret_key) where
 * secret_key = HMAC-SHA256(key="WebAppData", message=bot_token).
 * Note the key/message order on the first HMAC — getting it backwards
 * silently rejects every real initData (Telegram signs with
 * key "WebAppData", message bot_token).
 */
async function validateInitData(
  initData: string
): Promise<{ telegramId: number; user: Record<string, unknown> } | null> {
  if (!BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const userJson = params.get('user');
  if (!hash || !userJson) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), BOT_TOKEN);
  const signature = await hmacSha256(secretKey, dataCheckString);

  if (!timingSafeEqualHex(toHex(signature), hash)) return null;

  // Replay protection: reject captured initData older than 1 hour. Clients
  // get fresh initData from Telegram on every Mini App launch, so a tight
  // window costs nothing and bounds how long a leaked initData replays.
  // auth_date is part of the signed payload, so it cannot be forged once the
  // hash checks out.
  const MAX_AGE_SECONDS = 60 * 60;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > MAX_AGE_SECONDS) {
    return null;
  }

  try {
    const user = JSON.parse(userJson) as Record<string, unknown>;
    if (typeof user.id !== 'number') return null;
    return { telegramId: user.id, user };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let initData = '';
  try {
    const body = await req.json();
    initData = typeof body?.initData === 'string' ? body.initData : '';
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const validated = await validateInitData(initData);
  if (!validated) {
    return json({ error: 'Invalid initData' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const row = {
    telegram_id: validated.telegramId,
    first_name: String(validated.user.first_name ?? ''),
    last_name: validated.user.last_name ? String(validated.user.last_name) : null,
    username: validated.user.username ? String(validated.user.username) : null,
  };

  const { data: shopper, error } = await supabase
    .from('shoppers')
    .upsert(row, { onConflict: 'telegram_id' })
    .select()
    .single();

  if (error) {
    console.error('shopper upsert failed:', error.message);
    return json({ error: 'Failed to register shopper' }, 500);
  }

  // Order-history token for get_orders_by_telegram_id (062): the SQL side
  // recomputes this from the vault copy of the same secret. The key/message
  // order matches pgcrypto's hmac(data, key, 'sha256').
  const ordersToken = toHex(
    await hmacSha256(new TextEncoder().encode(ORDERS_TOKEN_SECRET), String(validated.telegramId))
  );

  return json({ shopper, ordersToken });
});
