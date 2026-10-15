// Verifies each merchant's payment proof on an order via verify.et.
// Triggered ONLY by the database (trg_orders_verify_payment AFTER INSERT on
// orders, or the retry_payment_verification RPC) — never by the client.
// Callers must present the shared internal token; there is no public path in,
// so random traffic cannot burn verify.et credits.
//
// Per merchant: payment completed · correct recipient (exact account match
// only — masked digits are never sufficient) · exact amount (items + delivery
// fee) · not previously claimed (atomic claim, only for fully passing
// payments) · receipt recency. Results land in payment_verifications (one row
// per attempt, full history) and are sent to the merchant's Telegram group.
//
// Required secrets: VERIFY_ET_API_KEY, VERIFY_FUNCTION_SECRET,
// TELEGRAM_BOT_TOKEN (already used by telegram-order-notify). Optional:
// RECEIPT_MAX_AGE_HOURS (default 24).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// NOTE: verification is currently paused — see VERIFICATION_PAUSED below.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { extractResultItem, parseReceipt } from '../_shared/verifyEvaluation.ts';
import { completeAttempt, type TenantProfile } from '../_shared/verifyWorkflow.ts';

const VERIFY_ET_API_KEY = Deno.env.get('VERIFY_ET_API_KEY') ?? '';
const INTERNAL_TOKEN = Deno.env.get('VERIFY_FUNCTION_SECRET') ?? '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_AGE_HOURS = Number(Deno.env.get('RECEIPT_MAX_AGE_HOURS') ?? '24') || 24;

const VERIFY_ET_URL = 'https://verify.et/api/verify';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/verify-et-webhook`;
const PROOFS_BUCKET = 'payment-proofs-private';
const DAILY_SUBMISSION_CAP = 500;
const IN_FLIGHT_MINUTES = 10;

// TEMPORARY: verification paused until the verify.et integration is
// finished. While true, every call short-circuits before any verify.et
// submission or Telegram message. Set to false (or delete this block)
// and redeploy to re-enable.
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

function basename(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

// --- verify.et registry sync ------------------------------------------------

interface RegistryAccount {
  accountNumber: string;
  bankName: string | null;
}

/** Best-effort: make sure every tenant bank account exists in the verify.et
 *  registry, so the receiver on a receipt can be resolved to a concrete
 *  account. Failures only degrade the recipient check to "review". */
async function syncRegistry(tenantAccounts: RegistryAccount[]): Promise<void> {
  try {
    const res = await fetch('https://verify.et/api/bank-accounts', {
      headers: { 'x-api-key': VERIFY_ET_API_KEY },
    });
    if (!res.ok) {
      console.error('registry list failed:', res.status, await res.text().catch(() => ''));
      return;
    }
    const body = await res.json().catch(() => null);
    const existing = new Set<string>();
    for (const item of Array.isArray(body?.data) ? body.data : []) {
      const num = item?.accountNumber ?? item?.account_number ?? item?.number;
      if (num) existing.add(String(num).replace(/\D/g, ''));
    }
    let added = 0;
    for (const account of tenantAccounts) {
      const digits = account.accountNumber.replace(/\D/g, '');
      if (!digits || existing.has(digits) || added >= 20) continue;
      const create = await fetch('https://verify.et/api/bank-accounts', {
        method: 'POST',
        headers: { 'x-api-key': VERIFY_ET_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber: account.accountNumber, bankName: account.bankName }),
      });
      if (create.ok) {
        existing.add(digits);
        added++;
      } else {
        console.error('registry add failed:', create.status, await create.text().catch(() => ''));
      }
    }
  } catch (error) {
    console.error('registry sync error:', error);
  }
}

// --- proof bytes --------------------------------------------------------------

async function fetchProofBytes(ref: string): Promise<Uint8Array> {
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    // Legacy rows: full URL on the public payment-proofs bucket.
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`proof download failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const { data, error } = await supabase.storage.from(PROOFS_BUCKET).download(ref);
  if (error || !data) throw new Error(`proof download failed: ${error?.message ?? 'no data'}`);
  return new Uint8Array(await data.arrayBuffer());
}

// --- verify.et submission ------------------------------------------------------

interface VerifyEtSubmission {
  payload: Record<string, unknown> | null;
  requestId: string | null;
  error: string | null;
}

async function submitToVerifyEt(image: Uint8Array, idempotencyKey: string): Promise<VerifyEtSubmission> {
  try {
    const form = new FormData();
    form.append('image', new Blob([image.buffer as ArrayBuffer], { type: 'image/jpeg' }), 'proof.jpg');
    form.append('webhookUrl', WEBHOOK_URL);
    const res = await fetch(`${VERIFY_ET_URL}?waitMs=25000`, {
      method: 'POST',
      headers: { 'x-api-key': VERIFY_ET_API_KEY, 'Idempotency-Key': idempotencyKey },
      body: form,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { payload: body, requestId: body?.requestId ?? null, error: `verify.et HTTP ${res.status}: ${body?.message ?? ''}` };
    }
    return { payload: body, requestId: body?.requestId ?? null, error: null };
  } catch (error) {
    return { payload: null, requestId: null, error: `verify.et request failed: ${String(error)}` };
  }
}

/** Bounded polling for queued verifications (the webhook is the primary
 *  completion path; this covers fast-but-not-instant OCR within the
 *  function's wall clock). */
async function pollVerifyEt(requestId: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${VERIFY_ET_URL}/${requestId}`, {
        headers: { 'x-api-key': VERIFY_ET_API_KEY },
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const item = extractResultItem(body);
      const receipt = item ? parseReceipt(item) : null;
      if (receipt && !receipt.processing) return body;
    } catch {
      return null;
    }
  }
  return null;
}

// --- per-merchant verification ------------------------------------------------------

interface OrderItem {
  product?: { owner_id?: string; ownerId?: string; price?: number };
  unitPrice?: number;
  quantity?: number;
}

function expectedSliceTotal(items: OrderItem[], tenantId: string, shippingFees: Record<string, number>): number {
  const subtotal = items
    .filter((i) => (i.product?.owner_id ?? i.product?.ownerId) === tenantId)
    .reduce((sum, i) => sum + (i.unitPrice ?? i.product?.price ?? 0) * (i.quantity ?? 1), 0);
  return subtotal + (shippingFees[tenantId] ?? 0);
}

async function verifyTenantSlice(
  order: {
    id: string;
    items: OrderItem[];
    created_at: string;
    payment_proofs: Record<string, string>;
    shipping_fees: Record<string, number>;
  },
  tenantId: string,
  proofRef: string,
  profile: TenantProfile
): Promise<string> {
  // Attempt management: short-circuit verified, skip in-flight, otherwise
  // open the next attempt and keep the old rows as history.
  const { data: current } = await supabase
    .from('payment_verifications')
    .select('*')
    .eq('order_id', order.id)
    .eq('tenant_id', tenantId)
    .eq('is_current', true)
    .maybeSingle();

  if (current?.status === 'verified') return 'already-verified';
  if (
    current?.status === 'pending' &&
    current.request_id &&
    Date.now() - new Date(current.updated_at).getTime() < IN_FLIGHT_MINUTES * 60 * 1000
  ) {
    return 'in-flight';
  }

  const attemptNo = (current?.attempt_no ?? 0) + 1;
  if (current) {
    await supabase.from('payment_verifications').update({ is_current: false }).eq('id', current.id);
  }
  const expectedAmount = expectedSliceTotal(order.items ?? [], tenantId, order.shipping_fees ?? {});
  const { data: attempt, error: attemptError } = await supabase
    .from('payment_verifications')
    .insert({ order_id: order.id, tenant_id: tenantId, attempt_no: attemptNo, expected_amount: expectedAmount })
    .select()
    .single();
  if (attemptError || !attempt) {
    console.error('attempt insert failed:', attemptError);
    return 'error';
  }

  const finish = async (patch: Record<string, unknown>): Promise<void> => {
    await supabase
      .from('payment_verifications')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', attempt.id);
  };

  try {
    const image = await fetchProofBytes(proofRef);
    const idempotencyKey = `order-${order.id}-${tenantId}-${attemptNo}-${basename(proofRef)}`.slice(0, 255);
    const submission = await submitToVerifyEt(image, idempotencyKey);

    if (submission.error && !submission.requestId) {
      // Temporary failure (network, 5xx, bank source down): never a fraud
      // verdict — the attempt stays retryable.
      await finish({
        status: 'error',
        raw: submission.payload,
        checks: { error: { result: 'review', reason: submission.error } },
      });
      return 'error';
    }

    let payload = submission.payload;
    let item = payload ? extractResultItem(payload) : null;
    let receipt = item ? parseReceipt(item) : null;

    if (receipt?.processing && submission.requestId) {
      const polled = await pollVerifyEt(submission.requestId);
      if (polled) {
        payload = polled;
        item = extractResultItem(payload);
        receipt = item ? parseReceipt(item) : null;
      }
    }

    if (!receipt) {
      await finish({
        status: 'error',
        request_id: submission.requestId,
        raw: payload,
        checks: { error: { result: 'review', reason: 'unreadable verify.et response' } },
      });
      return 'error';
    }
    if (receipt.processing) {
      // Still queued: the webhook completes this attempt.
      await finish({ status: 'pending', request_id: submission.requestId, raw: payload });
      return 'pending';
    }

    return await completeAttempt({
      supabase,
      botToken: BOT_TOKEN,
      order: { id: order.id, created_at: order.created_at },
      tenantId,
      profile,
      attempt: { id: attempt.id, attempt_no: attemptNo, expected_amount: expectedAmount },
      receipt,
      payload,
      requestId: submission.requestId,
      maxAgeHours: MAX_AGE_HOURS,
    });
  } catch (error) {
    console.error(`verification for ${order.id}/${tenantId} threw:`, error);
    await finish({ status: 'error', checks: { error: { result: 'review', reason: String(error).slice(0, 300) } } });
    return 'error';
  }
}

// --- entry point ------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (VERIFICATION_PAUSED) return json({ skipped: 'verification paused' });

  // Internal callers only (DB trigger / retry RPC). No publishable-key path.
  if (!INTERNAL_TOKEN || req.headers.get('x-internal-token') !== INTERNAL_TOKEN) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!VERIFY_ET_API_KEY) {
    console.error('VERIFY_ET_API_KEY secret is not set');
    return json({ error: 'verification not configured' }, 500);
  }

  let orderId: string;
  try {
    orderId = (await req.json())?.order_id;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!orderId) return json({ error: 'order_id required' }, 400);

  // Credit-balance guard: even an internal bug cannot loop submissions.
  const { count } = await supabase
    .from('payment_verifications')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString());
  if ((count ?? 0) >= DAILY_SUBMISSION_CAP) {
    console.error('daily verification cap reached');
    return json({ error: 'daily cap reached' }, 429);
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, items, created_at, payment_proofs, shipping_fees')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError || !order) return json({ error: 'order not found' }, 404);

  const proofs = (order.payment_proofs ?? {}) as Record<string, string>;
  const tenantIds = Object.keys(proofs);
  if (tenantIds.length === 0) return json({ results: {}, reason: 'no proofs' });

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, shop_name, telegram_chat_id, bank_accounts')
    .in('id', tenantIds);

  // Registry sync across ALL tenants, so any receiver can be resolved.
  const { data: allProfiles } = await supabase
    .from('profiles')
    .select('bank_accounts')
    .not('bank_accounts', 'eq', '[]');
  const registryAccounts: RegistryAccount[] = [];
  for (const p of allProfiles ?? []) {
    for (const a of Array.isArray(p.bank_accounts) ? p.bank_accounts : []) {
      const num = (a as { account_number?: string })?.account_number;
      if (num) registryAccounts.push({ accountNumber: num, bankName: (a as { bank_name?: string })?.bank_name ?? null });
    }
  }
  await syncRegistry(registryAccounts);

  const results: Record<string, string> = {};
  for (const tenantId of tenantIds) {
    const profile = (profiles ?? []).find((p) => p.id === tenantId) ?? {
      id: tenantId,
      shop_name: null,
      telegram_chat_id: null,
      bank_accounts: [],
    };
    results[tenantId] = await verifyTenantSlice(order, tenantId, proofs[tenantId], profile);
  }

  return json({ results });
});
