// Validates Telegram Mini App initData and upserts the shopper record.
// Called once per Mini App session by the client (no Supabase Auth involved —
// the signed initData IS the proof of identity).
//
// Required secrets (Supabase Dashboard > Edge Functions > Secrets):
//   TELEGRAM_BOT_TOKEN  — from @BotFather
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';

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

  if (toHex(signature) !== hash) return null;

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

  return json({ shopper });
});
