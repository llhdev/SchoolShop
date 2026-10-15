// Receives verify.et webhook callbacks for verifications that were still
// queued when verify-order-payment finished waiting. Verifies the webhook
// signature, completes the matching payment_verifications attempt (same
// shared evaluation as the synchronous path), and notifies the merchant.
//
// Idempotent: duplicate deliveries find the attempt already final and are
// acknowledged without re-notifying.
//
// Required secrets: VERIFY_ET_WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN. Optional:
// RECEIPT_MAX_AGE_HOURS (default 24).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// NOTE: verification is currently paused — see VERIFICATION_PAUSED below.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { extractResultItem, parseReceipt } from '../_shared/verifyEvaluation.ts';
import { completeAttempt, type TenantProfile } from '../_shared/verifyWorkflow.ts';

const WEBHOOK_SECRET = Deno.env.get('VERIFY_ET_WEBHOOK_SECRET') ?? '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_AGE_HOURS = Number(Deno.env.get('RECEIPT_MAX_AGE_HOURS') ?? '24') || 24;

// TEMPORARY: verification paused until the verify.et integration is
// finished. While true, webhook deliveries are acknowledged without
// completing attempts or messaging merchants. Set to false (or delete
// this block) and redeploy to re-enable.
const VERIFICATION_PAUSED = true;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** verify.et webhook signature (https://verify.et/docs/sdk):
 *  - X-Webhook-Timestamp: delivery time (ISO string or unix seconds)
 *  - X-Webhook-Signature: comma-separated `sha256=<hex>` parts, each the
 *    HMAC-SHA256 of `${timestamp}.${rawBody}` keyed by the whsec_ secret as-is
 *  - X-Webhook-Test: `true` on dashboard test pings (answer 204, no work)
 *  The timestamp must be within 5 minutes to block replays. */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return numeric > 1e12 ? numeric : numeric * 1000; // ms or unix seconds
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isSignatureValid(req: Request, rawBody: string): Promise<boolean> {
  if (!WEBHOOK_SECRET) return false;
  const timestamp = req.headers.get('x-webhook-timestamp') ?? '';
  const signature = req.headers.get('x-webhook-signature') ?? '';
  const sentAt = parseTimestampMs(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > TIMESTAMP_TOLERANCE_MS) {
    console.error('webhook rejected: stale/missing timestamp:', timestamp || '(none)');
    return false;
  }
  if (!signature) {
    console.error('webhook arrived without x-webhook-signature');
    return false;
  }
  const expected = await hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${rawBody}`);
  const parts = signature
    .split(',')
    .map((part) => part.trim().replace(/^sha256=/i, '').toLowerCase())
    .filter(Boolean);
  const valid = parts.some((part) => timingSafeEqualHex(part, expected));
  if (!valid) console.error('webhook signature mismatch');
  return valid;
}

function findRequestId(payload: Record<string, unknown>): string | null {
  const direct = payload.requestId ?? payload.request_id;
  if (typeof direct === 'string' && direct) return direct;
  const verification = payload.verification as Record<string, unknown> | undefined;
  const nested = verification?.requestId ?? verification?.request_id;
  return typeof nested === 'string' && nested ? nested : null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (VERIFICATION_PAUSED) return json({ skipped: 'verification paused' });

  const rawBody = await req.text();
  if (!(await isSignatureValid(req, rawBody))) {
    return json({ error: 'Invalid signature' }, 401);
  }

  // Dashboard test pings only prove the endpoint is reachable and the
  // signature checks out — acknowledge without touching any attempt.
  if (req.headers.get('x-webhook-test') === 'true') {
    return new Response(null, { status: 204 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const requestId = findRequestId(payload);
  if (!requestId) return json({ error: 'requestId missing' }, 400);

  const { data: attempt } = await supabase
    .from('payment_verifications')
    .select('*')
    .eq('request_id', requestId)
    .maybeSingle();
  if (!attempt) {
    console.error('webhook for unknown request:', requestId);
    // Acknowledge anyway — verify.et would otherwise keep retrying.
    return json({ skipped: 'unknown request' });
  }
  if (attempt.status !== 'pending') {
    // Duplicate delivery (or a retry already completed synchronously).
    return json({ skipped: 'already final' });
  }

  const item = extractResultItem(payload);
  const receipt = item ? parseReceipt(item) : null;
  if (!receipt) {
    await supabase
      .from('payment_verifications')
      .update({ status: 'error', raw: payload, updated_at: new Date().toISOString() })
      .eq('id', attempt.id);
    return json({ error: 'unreadable payload' }, 422);
  }
  if (receipt.processing) {
    // Not done yet; verify.et will deliver again (or a retry re-polls).
    return json({ skipped: 'still processing' });
  }

  const { data: order } = await supabase
    .from('orders')
    .select('id, created_at')
    .eq('id', attempt.order_id)
    .maybeSingle();
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, shop_name, telegram_chat_id, bank_accounts')
    .eq('id', attempt.tenant_id)
    .maybeSingle();
  if (!order || !profile) {
    console.error('webhook attempt missing order/profile:', attempt.id);
    return json({ error: 'order or profile missing' }, 500);
  }

  const overall = await completeAttempt({
    supabase,
    botToken: BOT_TOKEN,
    order: { id: order.id, created_at: order.created_at },
    tenantId: attempt.tenant_id,
    profile: profile as TenantProfile,
    attempt: { id: attempt.id, attempt_no: attempt.attempt_no, expected_amount: attempt.expected_amount },
    receipt,
    payload,
    requestId,
    maxAgeHours: MAX_AGE_HOURS,
  });

  return json({ status: overall });
});
