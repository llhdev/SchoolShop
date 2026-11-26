// Manual payment verification for staff: the financial admin (or super admin)
// types the transaction reference off the receipt when the automatic proof
// check could not confirm the payment (payment warning, 056 — OCR misread,
// verify.et down, reference not found). Since 073, BRANCH staff may run the
// same check, scoped to their branch's line items.
// The reference is looked up on verify.et synchronously and run through the
// same evaluateChecks rules as the automatic path (provider confirmation,
// recipient, exact amount, recency, 069 verification-era cutoff) plus the
// payment_claims ledger for prior use.
//
// On a fully clean pass the function does everything the staff would
// otherwise do by hand, in one shot:
//   orders.payment_references[tenant] = { provider, reference, key: 'manual' }
//   (067 shape), a verified current payment_verifications row, the atomic
//   claim (tenant-wide — duplicate protection is per shop), the tenant's
//   pending/received items auto-paid, and the shop's Telegram order message
//   flipped to ✅ Payment Verified. For a BRANCH caller (073) the auto-pay
//   flips only their branch's scoped items — the same scoping
//   update_order_item_status applies — and the payment_warnings entry is
//   cleared only when that leaves the tenant with NO remaining
//   pending/received items on the order (mirroring 072's clear-on-paid);
//   everyone else pays the whole shop's slice and clears the warning as
//   before.
// On failure the not-passing checks come back as plain-language reasons for
// the staff UI, and — since the failed-persist change — a definitive
// failed/needs_review verdict is ALSO recorded as the new current
// payment_verifications attempt, so the OrderDetail verification card shows
// THIS manual check's breakdown instead of a stale automatic one. Nothing
// else changes on the fail path: no claim, no payment_references, no warning
// change, no auto-pay, no Telegram flip. Transient outcomes (still pending,
// verify.et errors, not_found) and an already-claimed reference keep the old
// persist-nothing behavior. An already-verified (order, tenant)
// short-circuits idempotently before any verify.et call.
//
// Staff-authenticated: verify_jwt = true in config.toml, and this function
// additionally resolves the caller's JWT to their profile — super admin, or
// an active staff account with the Financial OR Branch capability acting for
// the requested tenant (their effective tenant).
//
// Required secrets: VERIFY_ET_API_KEY. Optional: TELEGRAM_BOT_TOKEN (the
// Telegram flip is skipped without it), RECEIPT_MAX_AGE_HOURS (default 24).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import {
  evaluateChecks,
  extractResultItem,
  parseReceipt,
  type ClaimOutcome,
} from '../_shared/verifyEvaluation.ts';
import { syncRegistry, type RegistryAccount } from '../_shared/verifyRegistry.ts';
import {
  attemptClaim,
  autoPayVerifiedItems,
  lineItemKey,
  markOrderMessageVerified,
  type TenantProfile,
} from '../_shared/verifyWorkflow.ts';
import { cbeSuffixFor } from '../_shared/referenceSuffix.ts';
import { resolveUnitPrice, type SelectedOption } from '../_shared/variantPricing.ts';
import {
  isVerificationEnabled,
  isVerificationEnabledForTenant,
} from '../_shared/verificationToggle.ts';

const VERIFY_ET_API_KEY = Deno.env.get('VERIFY_ET_API_KEY') ?? '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_AGE_HOURS = Number(Deno.env.get('RECEIPT_MAX_AGE_HOURS') ?? '24') || 24;

const VERIFY_ET_URL = 'https://verify.et/api/verify';

// Called from the browser (admin order screen) with apikey/authorization/json
// headers, so every request is CORS-preflighted — answer OPTIONS and tag every
// response, or the browser blocks the call before it reaches us.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

/** Failure payload for the staff UI: the reasons of every check that did not
 *  pass, in plain language. Definitive failed/needs_review verdicts are also
 *  persisted as the current attempt (see the call site); transient failures
 *  stay unpersisted. */
function fail(
  verdict: 'failed' | 'needs_review' | 'not_found' | 'unavailable',
  reasons: string[]
): Response {
  return json({ ok: false, verdict, reasons });
}

// --- auth ---------------------------------------------------------------------

interface AdminProfile {
  id: string;
  role: string;
  parent_tenant_id: string | null;
  staff_financial: boolean | null;
  staff_branch: boolean | null;
  branch_id: string | null;
  is_active: boolean | null;
}

/** Returns the caller's profile when they are a signed-in admin, else the
 *  error response (same pattern as r2-upload-sign). */
async function requireAdmin(
  req: Request
): Promise<{ profile: AdminProfile } | { error: Response }> {
  const token = (req.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'sign in required' }, 401) };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { error: json({ error: 'invalid session' }, 401) };
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, parent_tenant_id, staff_financial, staff_branch, branch_id, is_active')
    .eq('id', data.user.id)
    .maybeSingle();
  if (profile?.role !== 'admin' && profile?.role !== 'super_admin') {
    return { error: json({ error: 'admins only' }, 403) };
  }
  return { profile: profile as AdminProfile };
}

// --- input validation -----------------------------------------------------------

// verify.et's supported bank codes (references are looked up per bank).
const PROVIDERS = [
  'cbe',
  'telebirr',
  'dashen',
  'boa',
  'cbebirr',
  'awash',
  'mpesa',
  'siinqee',
  'kaafiebirr',
  'coopayebirr',
  'zemen',
] as const;

// Same reference shapes as verify-payment-reference and the
// set_order_payment_reference RPC (067): Telebirr transaction numbers are
// uppercase alnum (6-20), CBE Receipt IDs mixed-case alnum (8-24). Other
// providers only get the generic non-empty/length check.
const REFERENCE_PATTERNS: Record<string, RegExp> = {
  telebirr: /^[A-Z0-9]{6,20}$/,
  cbe: /^[A-Za-z0-9]{8,24}$/,
};

interface ManualVerifyRequest {
  orderId: string;
  tenantId: string;
  provider: string;
  reference: string;
}

function parseBody(raw: unknown): ManualVerifyRequest | string {
  if (!raw || typeof raw !== 'object') return 'invalid body';
  const b = raw as Record<string, unknown>;

  const orderId = typeof b.orderId === 'string' ? b.orderId.trim() : '';
  if (!orderId) return 'orderId required';

  const tenantId = typeof b.tenantId === 'string' ? b.tenantId.trim() : '';
  if (!tenantId) return 'tenantId required';

  const provider = typeof b.provider === 'string' ? b.provider.trim().toLowerCase() : '';
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    return 'unknown provider';
  }

  let reference = typeof b.reference === 'string' ? b.reference.trim() : '';
  if (provider === 'telebirr') reference = reference.toUpperCase();
  if (!reference || reference.length > 64) return 'reference required (<=64 chars)';
  const pattern = REFERENCE_PATTERNS[provider];
  if (pattern && !pattern.test(reference)) {
    return 'reference has the wrong format for this provider';
  }

  return { orderId, tenantId, provider, reference };
}

// --- verify.et reference lookup (same shapes as verify-payment-reference) -------

interface VerifyEtSubmission {
  payload: Record<string, unknown> | null;
  requestId: string | null;
  error: string | null;
  /** HTTP status when verify.et answered with an error — 400/422 mean the
   *  reference itself was rejected (map to not_found so the staff corrects
   *  it), everything else stays a retryable 'unavailable'. */
  status: number | null;
}

/** Synchronous reference lookup: no image, no settlementAccount (registry
 *  matching covers the recipient), no webhookUrl. Legacy CBE FT references
 *  additionally need the receiver account's 8-digit suffix. */
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
      return { payload: body, requestId: body?.requestId ?? null, error: `verify.et HTTP ${res.status}: ${body?.message ?? ''}`, status: res.status };
    }
    return { payload: body, requestId: body?.requestId ?? null, error: null, status: res.status };
  } catch (error) {
    return { payload: null, requestId: null, error: `verify.et request failed: ${String(error)}`, status: null };
  }
}

/** Bounded polling for queued lookups (same pattern as
 *  verify-payment-reference; there is no webhook for manual checks). */
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

/** verify.et reports unknown references as verification.status 'not_found';
 *  check every envelope shape extractResultItem knows about. */
function isNotFound(
  payload: Record<string, unknown> | null,
  item: Record<string, unknown> | null
): boolean {
  const candidates = [
    payload?.status,
    (payload?.verification as Record<string, unknown> | undefined)?.status,
    item?.status,
  ];
  return candidates.some((s) => typeof s === 'string' && s.toLowerCase() === 'not_found');
}

// --- expected amount (same calc as verify-order-payment) --------------------------

interface OrderItem {
  product?: { id?: string; owner_id?: string; ownerId?: string; price?: number };
  unitPrice?: number;
  quantity?: number;
  selectedOptions?: SelectedOption[];
  /** Branch stamp (045): matched against a branch caller's scope (073). */
  branchId?: string | null;
}

/** Expected slice total, recomputed from the catalog: the order's stored
 *  prices come from an anonymous client (public orders INSERT) and cannot be
 *  trusted. Products no longer in the catalog fall back to the order-time
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

// --- entry point ------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  const caller = auth.profile;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parseBody(rawBody);
  if (typeof parsed === 'string') return json({ error: parsed }, 400);
  const { orderId, tenantId, provider, reference } = parsed;

  // Capability gate (067/073): the super admin, or an ACTIVE staff account
  // with the Financial OR Branch capability acting for its own effective
  // tenant.
  const callerTenant = caller.parent_tenant_id ?? caller.id;
  const callerIsStaff = caller.is_active !== false && callerTenant === tenantId;
  const callerIsFinancial = callerIsStaff && caller.staff_financial === true;
  const callerIsBranch = callerIsStaff && caller.staff_branch === true;
  const authorized =
    caller.role === 'super_admin' || callerIsFinancial || callerIsBranch;
  if (!authorized) {
    return json({ error: "only the super admin or the shop's financial or branch staff can verify payments manually" }, 403);
  }

  // Runtime kill-switches (042/043): a disabled pipeline stays off for manual
  // checks too — the staff can still mark items paid directly.
  if (!(await isVerificationEnabled(supabase))) {
    return fail('unavailable', ['payment verification is currently disabled — mark the items paid manually instead']);
  }
  if (!(await isVerificationEnabledForTenant(supabase, tenantId))) {
    return fail('unavailable', ['payment verification is disabled for this shop — mark the items paid manually instead']);
  }
  if (!VERIFY_ET_API_KEY) {
    console.error('VERIFY_ET_API_KEY secret is not set');
    return json({ error: 'verification not configured' }, 500);
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, items, created_at, payment_references, payment_warnings')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError || !order) return json({ error: 'order not found' }, 404);

  const items = (Array.isArray(order.items) ? order.items : []) as OrderItem[];
  if (!items.some((i) => (i.product?.owner_id ?? i.product?.ownerId) === tenantId)) {
    return json({ error: 'this order has no items from that shop' }, 400);
  }

  const { data: profileRow } = await supabase
    .from('profiles')
    .select('id, shop_name, telegram_chat_id, bank_accounts, shipping_fee, payment_verification_started_at, branch_selection_enabled')
    .eq('id', tenantId)
    .maybeSingle();
  if (!profileRow) return json({ error: 'shop not found' }, 400);
  const tenantProfile = profileRow as TenantProfile;

  // 073 branch scoping, mirroring the item lookup in update_order_item_status
  // (and getOrderItemsForScope client-side): a staff caller with a branch_id
  // sees/pays only items stamped with THEIR branch while the shop's
  // branch-selection toggle (046) is on; unstamped items (053) are shop-wide
  // for them. The super admin and staff without a branch_id are unscoped.
  const branchSelectionEnabled =
    (tenantProfile.branch_selection_enabled as boolean | null | undefined) !== false;
  const branchScope = {
    branchId: caller.role === 'super_admin' ? null : (caller.branch_id ?? null),
    branchSelectionEnabled,
  };
  const scopeActive = !!branchScope.branchId && branchSelectionEnabled;
  const inScope = (i: OrderItem) =>
    !scopeActive || i.branchId == null || i.branchId === branchScope.branchId;

  const ownedItems = items.filter((i) => (i.product?.owner_id ?? i.product?.ownerId) === tenantId);
  if (scopeActive && !ownedItems.some(inScope)) {
    return json({ error: 'this order has no items from your branch' }, 400);
  }

  // Idempotent short-circuit: a verified current attempt means this is a
  // retry — no verify.et credit is spent.
  const { data: current } = await supabase
    .from('payment_verifications')
    .select('id, attempt_no, status')
    .eq('order_id', orderId)
    .eq('tenant_id', tenantId)
    .eq('is_current', true)
    .maybeSingle();
  if (current?.status === 'verified') return json({ ok: true, alreadyVerified: true });

  // Claims ledger pre-check: free, before any verify.et credit is spent. A
  // claim held by THIS order is a retry of a partially completed run.
  const { data: claim } = await supabase
    .from('payment_claims')
    .select('order_id')
    .eq('provider', provider)
    .eq('reference', reference)
    .maybeSingle();
  if (claim && claim.order_id !== orderId) {
    return fail('failed', [`this transaction was already used on order ${claim.order_id}`]);
  }

  // Registry sync for THIS tenant only, so settlement matching can resolve
  // the receiver to this shop's account.
  const tenantAccounts: RegistryAccount[] = (
    Array.isArray(tenantProfile.bank_accounts) ? tenantProfile.bank_accounts : []
  )
    .map((a) => ({
      accountNumber: (a as { account_number?: string })?.account_number ?? '',
      bankName: (a as { bank_name?: string })?.bank_name ?? null,
    }))
    .filter((a) => a.accountNumber);
  await syncRegistry(VERIFY_ET_API_KEY, tenantAccounts);

  // Stable idempotency key: retrying the same reference replays the verify.et
  // result for free instead of charging a new verification.
  const suffix = cbeSuffixFor(provider, reference, tenantAccounts);
  const idempotencyKey = `manual-${orderId}-${tenantId}-${provider}-${reference}`.slice(0, 255);
  const submission = await submitReferenceToVerifyEt(provider, reference, idempotencyKey, suffix);
  if (submission.error && !submission.requestId) {
    // 400/422: verify.et rejected the reference itself (wrong format for the
    // bank) — the staff can correct it. Everything else (5xx, network,
    // timeout) is a temporary failure: retryable, never a fraud verdict.
    const badReference = submission.status === 400 || submission.status === 422;
    console.error('verify.et submission failed:', submission.error);
    return fail(
      badReference ? 'not_found' : 'unavailable',
      [
        badReference
          ? 'the bank rejected this reference — check it and try again'
          : 'payment verification is temporarily unavailable — retry in a moment',
      ]
    );
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

  if (isNotFound(payload, item)) {
    return fail('not_found', ['transaction not found — check the provider and the reference']);
  }
  if (!receipt || receipt.processing) {
    return fail('unavailable', ['verify.et is still processing this lookup — retry in a moment']);
  }

  const expectedAmount = await expectedSliceTotal(items, tenantId, tenantProfile);
  const evaluation = evaluateChecks({
    receipt,
    merchantAccounts: tenantAccounts.map((a) => a.accountNumber),
    expectedAmount,
    orderCreatedAt: order.created_at as string,
    claimOutcome: claim ? { kind: 'same_order' } : { kind: 'not_attempted' },
    maxAgeHours: MAX_AGE_HOURS,
    verificationStartedAt: tenantProfile.payment_verification_started_at ?? null,
  });

  if (evaluation.overall !== 'verified') {
    const reasons = Object.values(evaluation.checks)
      .filter((c) => c.result !== 'pass')
      .map((c) => c.reason);
    // Persist a DEFINITIVE failed/needs_review verdict as the new current
    // attempt (the previous one becomes history, same as the pass path), so
    // the OrderDetail verification card renders THIS manual check's
    // pass/fail breakdown instead of a stale automatic attempt. checks keeps
    // evaluateChecks' own notPreviouslyClaimed line — for not_attempted that
    // is the accurate "not claimed" pass, exactly what completeAttempt
    // stores when no claim happens. HARD RULE: nothing else is written on
    // this path — no payment_claims row, no orders.payment_references, no
    // payment_warnings change, no auto-pay, no Telegram flip. 'pending'
    // (still processing) never persists: a fresh request_id on a pending row
    // would trip verify-order-payment's in-flight skip. Persist errors are
    // best-effort only — the staff answer stays the verdict + reasons.
    if (evaluation.overall === 'failed' || evaluation.overall === 'needs_review') {
      if (current) {
        await supabase.from('payment_verifications').update({ is_current: false }).eq('id', current.id);
      }
      const { error: persistError } = await supabase
        .from('payment_verifications')
        .insert({
          order_id: orderId,
          tenant_id: tenantId,
          attempt_no: (current?.attempt_no ?? 0) + 1,
          expected_amount: expectedAmount,
          status: evaluation.overall,
          checks: evaluation.checks,
          paid_amount: receipt.paidAmount,
          provider,
          reference,
          receiver_account: receipt.receiverAccount,
          payer: receipt.payer,
          transaction_date: receipt.transactionDate,
          request_id: submission.requestId,
          raw: payload,
        });
      if (persistError) {
        console.error('failed-attempt persist failed:', persistError);
        if (current) {
          await supabase.from('payment_verifications').update({ is_current: true }).eq('id', current.id);
        }
      }
    }
    return fail(
      evaluation.overall === 'pending' ? 'unavailable' : evaluation.overall,
      reasons.length > 0 ? reasons : ['the transaction could not be confirmed']
    );
  }

  // Fully clean pass — persist. New current attempt row first so the atomic
  // claim can reference it; the previous current row becomes history, same as
  // the automatic path.
  if (current) {
    await supabase.from('payment_verifications').update({ is_current: false }).eq('id', current.id);
  }
  const { data: attempt, error: attemptError } = await supabase
    .from('payment_verifications')
    .insert({
      order_id: orderId,
      tenant_id: tenantId,
      attempt_no: (current?.attempt_no ?? 0) + 1,
      expected_amount: expectedAmount,
    })
    .select('id')
    .single();
  if (attemptError || !attempt) {
    console.error('attempt insert failed:', attemptError);
    if (current) {
      await supabase.from('payment_verifications').update({ is_current: true }).eq('id', current.id);
    }
    return json({ error: 'could not record the verification — retry' }, 500);
  }

  /** Undo the attempt row (+ restore the previous current one) when the run
   *  cannot complete — failed manual attempts persist nothing. */
  const rollbackAttempt = async () => {
    await supabase.from('payment_verifications').delete().eq('id', attempt.id);
    if (current) {
      await supabase.from('payment_verifications').update({ is_current: true }).eq('id', current.id);
    }
  };

  let claimOutcome: ClaimOutcome;
  try {
    claimOutcome = await attemptClaim(supabase, provider, reference, orderId, tenantId, attempt.id);
  } catch (error) {
    console.error('claim failed:', error);
    await rollbackAttempt();
    return json({ error: 'could not claim the transaction — retry' }, 500);
  }
  if (claimOutcome.kind === 'other_order') {
    // Lost a race: another order claimed this reference between the pre-check
    // and now.
    await rollbackAttempt();
    return fail('failed', [`this transaction was already used on order ${claimOutcome.holderOrderId}`]);
  }

  const checks = {
    ...evaluation.checks,
    notPreviouslyClaimed:
      claimOutcome.kind === 'same_order'
        ? { result: 'pass', reason: 'claimed by this order (retry)' }
        : { result: 'pass', reason: 'first use of this transaction' },
  };
  const { error: attemptUpdateError } = await supabase
    .from('payment_verifications')
    .update({
      status: 'verified',
      checks,
      paid_amount: receipt.paidAmount,
      provider,
      reference,
      receiver_account: receipt.receiverAccount,
      payer: receipt.payer,
      transaction_date: receipt.transactionDate,
      request_id: submission.requestId,
      raw: payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', attempt.id);
  if (attemptUpdateError) {
    // The claim already holds for this order — log loudly; the reference
    // recording below still proceeds so a retry completes cleanly.
    console.error('attempt update failed:', attemptUpdateError);
  }

  // Record the reference on the order (067 shape) and clear the shop's
  // payment warning (056). Read-modify-write both jsonb columns in one
  // update; the claim above makes concurrent runs for the same reference
  // impossible. 073: a branch-scoped caller does NOT clear the warning here —
  // their auto-pay covers only their branch's items, so the warning clears
  // below only when the tenant has no remaining pending/received items.
  const references = { ...((order.payment_references ?? {}) as Record<string, unknown>) };
  references[tenantId] = { provider, reference, key: 'manual' };
  const warnings = { ...((order.payment_warnings ?? {}) as Record<string, unknown>) };
  if (!scopeActive) delete warnings[tenantId];
  const { error: orderUpdateError } = await supabase
    .from('orders')
    .update({ payment_references: references, payment_warnings: warnings })
    .eq('id', orderId);
  if (orderUpdateError) console.error('order update failed:', orderUpdateError);

  // Auto-pay + Telegram flip: same swallow-errors discipline as
  // completeAttempt — they must never fail the verification. A branch-scoped
  // caller pays only their branch's pending/received items (073).
  try {
    await autoPayVerifiedItems(supabase, orderId, tenantId, branchScope);
  } catch (error) {
    console.error(`auto-pay failed for order ${orderId}:`, error);
  }
  if (scopeActive) {
    // 073: clear the tenant's payment warning only when the scoped auto-pay
    // leaves the tenant with NO remaining pending/received items on the
    // order — the same state in which 072's clear-on-paid fires for a
    // whole-shop payment. Otherwise the warning stays for the rest.
    try {
      const { data: after } = await supabase
        .from('orders')
        .select('items, item_statuses, status')
        .eq('id', orderId)
        .single();
      const afterItems = Array.isArray(after?.items) ? (after.items as OrderItem[]) : [];
      const afterStatuses =
        after?.item_statuses && typeof after.item_statuses === 'object' && !Array.isArray(after.item_statuses)
          ? (after.item_statuses as Record<string, string>)
          : {};
      const orderStatus = typeof after?.status === 'string' ? after.status : 'pending';
      const hasOpen = afterItems.some((i) => {
        if ((i.product?.owner_id ?? i.product?.ownerId) !== tenantId) return false;
        const key = lineItemKey(i);
        const effective = (key && afterStatuses[key]) || orderStatus;
        return effective === 'pending' || effective === 'received';
      });
      if (!hasOpen) {
        const { data: latest } = await supabase
          .from('orders')
          .select('payment_warnings')
          .eq('id', orderId)
          .single();
        const latestWarnings = { ...((latest?.payment_warnings ?? {}) as Record<string, unknown>) };
        delete latestWarnings[tenantId];
        const { error: warningError } = await supabase
          .from('orders')
          .update({ payment_warnings: latestWarnings })
          .eq('id', orderId);
        if (warningError) console.error('scoped warning clear failed:', warningError);
      }
    } catch (error) {
      console.error(`scoped warning clear failed for order ${orderId}:`, error);
    }
  }
  try {
    await markOrderMessageVerified(supabase, BOT_TOKEN, orderId, tenantId);
  } catch (error) {
    console.error(`telegram inline-verify edit failed for order ${orderId}:`, error);
  }

  return json({ ok: true, verdict: 'verified' });
});
