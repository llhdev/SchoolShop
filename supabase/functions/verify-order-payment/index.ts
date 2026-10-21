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
// NOTE: verification can be stopped at runtime — see
// platform_settings.payment_verification_enabled (migration 042).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { extractResultItem, parseReceipt } from '../_shared/verifyEvaluation.ts';
import { syncRegistry, type RegistryAccount } from '../_shared/verifyRegistry.ts';
import { completeAttempt, type TenantProfile } from '../_shared/verifyWorkflow.ts';
import { cbeSuffixFor } from '../_shared/referenceSuffix.ts';
import { resolveUnitPrice, type SelectedOption } from '../_shared/variantPricing.ts';
import { isVerificationEnabled } from '../_shared/verificationToggle.ts';
import { R2_PROOFS_BUCKET, presign, r2Configured } from '../_shared/r2Sign.ts';

const VERIFY_ET_API_KEY = Deno.env.get('VERIFY_ET_API_KEY') ?? '';
const INTERNAL_TOKEN = Deno.env.get('VERIFY_FUNCTION_SECRET') ?? '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_AGE_HOURS = Number(Deno.env.get('RECEIPT_MAX_AGE_HOURS') ?? '24') || 24;

const VERIFY_ET_URL = 'https://verify.et/api/verify';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/verify-et-webhook`;
// Legacy Supabase bucket — proofs now live in the private R2 bucket
// (R2_PROOFS_BUCKET); the Supabase path is the not-yet-migrated fallback.
const PROOFS_BUCKET = 'payment-proofs-private';
const DAILY_SUBMISSION_CAP = 500;
const IN_FLIGHT_MINUTES = 10;

// Verification can be stopped at runtime by the super admin via
// platform_settings.payment_verification_enabled (see
// _shared/verificationToggle.ts) — no redeploy needed.

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

// --- proof bytes --------------------------------------------------------------

async function fetchProofBytes(ref: string): Promise<Uint8Array> {
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    // Legacy rows: full URL on the public payment-proofs bucket.
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`proof download failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  // Proofs live in the private R2 bucket; fall back to the legacy Supabase
  // bucket for objects not yet migrated.
  if (r2Configured()) {
    const res = await fetch(await presign('GET', R2_PROOFS_BUCKET, ref, 600));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
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

/** Reference-based submission (no image): used when the order carries a
 *  checkout-verified payment_references entry. The idempotency key is the
 *  SAME key the pre-order check used, so verify.et replays that result
 *  instead of charging a new verification. The body must stay byte-identical
 *  to the pre-check's ({ bank, reference } plus the suffix when applicable —
 *  no webhookUrl, which is registered on the verify.et dashboard anyway), or
 *  the replay turns into a
 *  409 key conflict. Legacy CBE FT references additionally carry the receiver
 *  account's 8-digit suffix — cbeSuffixFor derives it from the tenant profile
 *  in both functions, so the replay body matches the pre-check's. The
 *  response envelope is identical to the image path, so everything
 *  downstream is unchanged. */
async function submitReferenceToVerifyEt(
  provider: string,
  reference: string,
  idempotencyKey: string,
  suffix?: string
): Promise<VerifyEtSubmission> {
  try {
    const res = await fetch(`${VERIFY_ET_URL}?waitMs=25000`, {
      method: 'POST',
      headers: {
        'x-api-key': VERIFY_ET_API_KEY,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bank: provider, reference, ...(suffix ? { suffix } : {}) }),
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
  product?: { id?: string; owner_id?: string; ownerId?: string; price?: number };
  unitPrice?: number;
  quantity?: number;
  selectedOptions?: SelectedOption[];
}

/** Expected slice total, recomputed from the catalog: the order's stored
 *  prices come from an anonymous client (public orders INSERT) and cannot be
 *  trusted — a crafted order could snapshot a fake total matching a small
 *  receipt. Products no longer in the catalog fall back to the order-time
 *  snapshot (legacy rows). The shipping fee comes from the tenant's profile,
 *  not the client-sent shipping_fees. */
async function expectedSliceTotal(
  items: OrderItem[],
  tenantId: string,
  profile: TenantProfile
): Promise<number> {
  const owned = items.filter((i) => (i.product?.owner_id ?? i.product?.ownerId) === tenantId);
  const ids = [...new Set(owned.map((i) => i.product?.id).filter((id): id is string => !!id))];
  const { data: products } = ids.length
    ? await supabase.from('products').select('id, price, variants').in('id', ids)
    : { data: [] as { id: string; price: number; variants: unknown }[] };
  const byId = new Map((products ?? []).map((p) => [p.id as string, p]));
  const subtotal = owned.reduce((sum, i) => {
    const catalog = i.product?.id ? byId.get(i.product.id) : undefined;
    const unit = catalog
      ? resolveUnitPrice(catalog, i.selectedOptions ?? [])
      : (i.unitPrice ?? i.product?.price ?? 0);
    return sum + unit * (i.quantity ?? 1);
  }, 0);
  return subtotal + (Number(profile.shipping_fee) || 0);
}

async function verifyTenantSlice(
  order: {
    id: string;
    items: OrderItem[];
    created_at: string;
    payment_proofs: Record<string, string>;
    shipping_fees: Record<string, number>;
    payment_references: Record<string, { provider?: string; reference?: string; key?: string }>;
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
  const expectedAmount = await expectedSliceTotal(order.items ?? [], tenantId, profile);
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
    // Reference path (new checkouts): the shopper's reference was already
    // verified pre-order; replay it with the same idempotency key (free).
    // Legacy orders have no payment_references entry and keep the image
    // submission below.
    const refEntry = order.payment_references?.[tenantId];
    let submission: VerifyEtSubmission;
    if (refEntry?.provider && refEntry?.reference && refEntry?.key) {
      const tenantAccounts = (Array.isArray(profile.bank_accounts) ? profile.bank_accounts : []).map(
        (a) => ({
          accountNumber: (a as { account_number?: string })?.account_number ?? '',
          bankName: (a as { bank_name?: string })?.bank_name ?? null,
        })
      );
      const suffix = cbeSuffixFor(refEntry.provider, refEntry.reference, tenantAccounts);
      submission = await submitReferenceToVerifyEt(refEntry.provider, refEntry.reference, refEntry.key, suffix);
    } else {
      const image = await fetchProofBytes(proofRef);
      const idempotencyKey = `order-${order.id}-${tenantId}-${attemptNo}-${basename(proofRef)}`.slice(0, 255);
      submission = await submitToVerifyEt(image, idempotencyKey);
    }

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

  if (!(await isVerificationEnabled(supabase))) return json({ skipped: 'verification disabled' });

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
    .select('id, items, created_at, payment_proofs, shipping_fees, payment_references')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError || !order) return json({ error: 'order not found' }, 404);

  const proofs = (order.payment_proofs ?? {}) as Record<string, string>;
  const tenantIds = Object.keys(proofs);
  if (tenantIds.length === 0) return json({ results: {}, reason: 'no proofs' });

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, shop_name, telegram_chat_id, bank_accounts, shipping_fee, payment_verification_enabled')
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
  await syncRegistry(VERIFY_ET_API_KEY, registryAccounts);

  const results: Record<string, string> = {};
  for (const tenantId of tenantIds) {
    const profile = (profiles ?? []).find((p) => p.id === tenantId) ?? {
      id: tenantId,
      shop_name: null,
      telegram_chat_id: null,
      bank_accounts: [],
      payment_verification_enabled: true,
    };
    // Per-tenant switch (043): excluded shops are skipped outright — no
    // verify.et submission, no payment_verifications row, no Telegram
    // verification message. Their proofs still reach the tenant via
    // telegram-order-notify.
    if (profile.payment_verification_enabled === false) {
      results[tenantId] = 'skipped';
      continue;
    }
    results[tenantId] = await verifyTenantSlice(order, tenantId, proofs[tenantId], profile);
  }

  return json({ results });
});
