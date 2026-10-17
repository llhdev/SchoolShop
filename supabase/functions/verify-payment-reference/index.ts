// Pre-order, READ-ONLY payment verification for anonymous shoppers.
// Called at checkout (per shop, after the payment-proof upload) with the
// transaction reference the client read off the proof; checks it against
// verify.et's reference API and returns a structured verdict. The Place
// Order button is gated on every shop reaching 'verified'.
//
// Unlike verify-order-payment this function never writes payment_claims or
// payment_verifications — claims stay post-order and authoritative. Every
// call IS logged in payment_prechecks keyed by the client-supplied
// idempotency key: same-key retries replay the stored verdict without a new
// verify.et call, and the order-time verification reuses the same key so
// verify.et replays it for free.
//
// Credit-burn protection (verify_jwt is off — shoppers are anonymous):
//   - the proof object must exist in the private payment-proofs-private
//     bucket (only real uploads pass),
//   - a daily cap on new pre-checks (same style as DAILY_SUBMISSION_CAP),
//   - idempotent replays never re-call verify.et.
//
// Required secrets: VERIFY_ET_API_KEY. Optional: RECEIPT_MAX_AGE_HOURS
// (default 24). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided
// automatically.
//
// NOTE: verification can be stopped at runtime — see
// platform_settings.payment_verification_enabled (migration 042). While
// disabled this returns a 200 {skipped} the client maps to 'unavailable';
// the checkout screen hides the verification step entirely when the flag
// is off.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import {
  evaluateChecks,
  extractResultItem,
  parseReceipt,
} from '../_shared/verifyEvaluation.ts';
import { syncRegistry, type RegistryAccount } from '../_shared/verifyRegistry.ts';
import { resolveUnitPrice, type SelectedOption } from '../_shared/variantPricing.ts';
import { isVerificationEnabled } from '../_shared/verificationToggle.ts';

const VERIFY_ET_API_KEY = Deno.env.get('VERIFY_ET_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_AGE_HOURS = Number(Deno.env.get('RECEIPT_MAX_AGE_HOURS') ?? '24') || 24;

const VERIFY_ET_URL = 'https://verify.et/api/verify';
const PROOFS_BUCKET = 'payment-proofs-private';
const DAILY_PRECHECK_CAP = 500;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Verdict =
  | 'verified'
  | 'not_found'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'already_claimed'
  | 'unavailable';

interface PrecheckPayload {
  verdict: Verdict;
  provider: string;
  reference: string;
  paidAmount: number | null;
  expectedAmount: number;
  requestId: string | null;
}

// --- input validation ---------------------------------------------------------

// Lenient charset/length per provider: Telebirr transaction numbers are
// uppercase alnum (~6-20), CBE Receipt IDs mixed-case alnum (~8-24).
const REFERENCE_PATTERNS: Record<string, RegExp> = {
  telebirr: /^[A-Z0-9]{6,20}$/,
  cbe: /^[A-Za-z0-9]{8,24}$/,
};

interface PrecheckItem {
  productId: string;
  quantity: number;
  selectedOptions: SelectedOption[];
}

interface PrecheckRequest {
  tenantId: string;
  provider: 'cbe' | 'telebirr';
  reference: string;
  key: string;
  proofRef: string;
  items: PrecheckItem[];
}

function parseBody(raw: unknown): PrecheckRequest | string {
  if (!raw || typeof raw !== 'object') return 'invalid body';
  const b = raw as Record<string, unknown>;

  const tenantId = typeof b.tenantId === 'string' ? b.tenantId.trim() : '';
  if (!tenantId) return 'tenantId required';

  const provider = typeof b.provider === 'string' ? b.provider.trim().toLowerCase() : '';
  if (provider !== 'cbe' && provider !== 'telebirr') return 'provider must be cbe or telebirr';

  const reference = typeof b.reference === 'string' ? b.reference.trim() : '';
  if (!reference || reference.length > 64 || !REFERENCE_PATTERNS[provider].test(reference)) {
    return 'reference has the wrong format for this provider';
  }

  const key = typeof b.key === 'string' ? b.key.trim() : '';
  if (!key || key.length > 128) return 'key required (<=128 chars)';

  const proofRef = typeof b.proofRef === 'string' ? b.proofRef.trim() : '';
  if (!proofRef || proofRef.includes('..') || proofRef.startsWith('/')) return 'invalid proofRef';

  if (!Array.isArray(b.items) || b.items.length === 0) return 'items must be a non-empty array';
  const items: PrecheckItem[] = [];
  for (const rawItem of b.items) {
    if (!rawItem || typeof rawItem !== 'object') return 'invalid item';
    const i = rawItem as Record<string, unknown>;
    const productId = typeof i.productId === 'string' ? i.productId.trim() : '';
    if (!productId) return 'item productId required';
    const quantity = i.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) {
      return 'item quantity must be a positive integer';
    }
    const selectedOptions: SelectedOption[] = [];
    if (i.selectedOptions !== undefined) {
      if (!Array.isArray(i.selectedOptions)) return 'invalid selectedOptions';
      for (const rawOpt of i.selectedOptions) {
        const o = rawOpt as Record<string, unknown>;
        if (!o || typeof o.group !== 'string' || typeof o.option !== 'string') {
          return 'invalid selectedOptions entry';
        }
        selectedOptions.push({ group: o.group, option: o.option });
      }
    }
    items.push({ productId, quantity, selectedOptions });
  }

  return { tenantId, provider, reference, key, proofRef, items };
}

// --- verify.et reference API ----------------------------------------------------

interface VerifyEtSubmission {
  payload: Record<string, unknown> | null;
  requestId: string | null;
  error: string | null;
  /** HTTP status when verify.et answered with an error — 400/422 mean the
   *  reference itself was rejected (map to not_found so the shopper corrects
   *  it), everything else stays a retryable 'unavailable'. */
  status: number | null;
}

/** Synchronous reference lookup: no image, no settlementAccount (registry
 *  matching covers the recipient), no webhookUrl. */
async function submitReferenceToVerifyEt(
  provider: string,
  reference: string,
  idempotencyKey: string
): Promise<VerifyEtSubmission> {
  try {
    const res = await fetch(`${VERIFY_ET_URL}?waitMs=25000`, {
      method: 'POST',
      headers: {
        'x-api-key': VERIFY_ET_API_KEY,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bank: provider, reference }),
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
 *  verify-order-payment; there is no webhook for pre-order checks). */
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

// --- entry point ------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!(await isVerificationEnabled(supabase))) return json({ skipped: 'verification disabled' });

  if (!VERIFY_ET_API_KEY) {
    console.error('VERIFY_ET_API_KEY secret is not set');
    return json({ error: 'verification not configured' }, 500);
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parseBody(rawBody);
  if (typeof parsed === 'string') return json({ error: parsed }, 400);
  const { tenantId, provider, reference, key, proofRef, items } = parsed;

  // Idempotency replay: a stored verdict is returned as-is, no verify.et call.
  const { data: existing } = await supabase
    .from('payment_prechecks')
    .select('verdict')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (existing?.verdict) return json(existing.verdict);

  // Proof gate: the referenced proof must actually exist in the private
  // bucket (bytes discarded) — credit burn is limited to real uploads.
  const { error: proofError } = await supabase.storage.from(PROOFS_BUCKET).download(proofRef);
  if (proofError) return json({ error: 'proof not found' }, 400);

  // Daily cap on new pre-checks.
  const { count } = await supabase
    .from('payment_prechecks')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString());
  if ((count ?? 0) >= DAILY_PRECHECK_CAP) {
    console.error('daily precheck cap reached');
    return json({ error: 'daily cap reached' }, 429);
  }

  // Server-side expected amount: fetch the products, resolve variant unit
  // prices, add the tenant's flat shipping fee. Client-sent amounts ignored.
  const productIds = [...new Set(items.map((i) => i.productId))];
  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, price, owner_id, variants')
    .in('id', productIds);
  if (productsError) {
    console.error('product fetch failed:', productsError);
    return json({ error: 'could not load products' }, 500);
  }
  interface ProductRow {
    price: number;
    owner_id: string;
    variants: unknown;
  }
  const byId = new Map<string, ProductRow>(
    (products ?? []).map((p) => [p.id as string, p as ProductRow] as [string, ProductRow])
  );
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product || product.owner_id !== tenantId) {
      return json({ error: 'items must belong to this shop' }, 400);
    }
  }
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, bank_accounts, shipping_fee')
    .eq('id', tenantId)
    .maybeSingle();
  if (!profile) return json({ error: 'shop not found' }, 400);

  const itemsTotal = items.reduce(
    (sum, i) => sum + resolveUnitPrice(byId.get(i.productId)!, i.selectedOptions) * i.quantity,
    0
  );
  const expectedAmount = itemsTotal + (Number(profile.shipping_fee) || 0);

  // Persist + return one verdict payload; same-key retries replay the row.
  const finish = async (
    verdict: Verdict,
    paidAmount: number | null,
    requestId: string | null
  ): Promise<Response> => {
    const payload: PrecheckPayload = {
      verdict,
      provider,
      reference,
      paidAmount,
      expectedAmount,
      requestId,
    };
    const { error } = await supabase
      .from('payment_prechecks')
      .upsert(
        { idempotency_key: key, provider, reference, verdict: payload },
        { onConflict: 'idempotency_key' }
      );
    if (error) console.error('precheck store failed:', error);
    return json(payload);
  };

  // Cheap claim pre-check: a claimed reference is a hard rejection without
  // spending a verify.et credit. (Claims are only created post-order, so
  // every row here means another order already used this reference.)
  const { data: claim } = await supabase
    .from('payment_claims')
    .select('order_id')
    .eq('provider', provider)
    .eq('reference', reference)
    .maybeSingle();
  if (claim) return finish('already_claimed', null, null);

  // Registry sync for THIS tenant only, so settlement matching can resolve
  // the receiver to this shop's account.
  const tenantAccounts: RegistryAccount[] = (Array.isArray(profile.bank_accounts) ? profile.bank_accounts : [])
    .map((a) => ({
      accountNumber: (a as { account_number?: string })?.account_number ?? '',
      bankName: (a as { bank_name?: string })?.bank_name ?? null,
    }))
    .filter((a) => a.accountNumber);
  await syncRegistry(VERIFY_ET_API_KEY, tenantAccounts);

  const submission = await submitReferenceToVerifyEt(provider, reference, key);
  if (submission.error && !submission.requestId) {
    // 400/422: verify.et rejected the reference itself (wrong format for the
    // bank) — the shopper can correct it, so surface it as not_found.
    // Everything else (5xx, network, timeout) is a temporary failure:
    // retryable, never a fraud verdict.
    const badReference = submission.status === 400 || submission.status === 422;
    return finish(badReference ? 'not_found' : 'unavailable', null, submission.requestId);
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

  if (isNotFound(payload, item)) return finish('not_found', null, submission.requestId);
  if (!receipt || receipt.processing) {
    return finish('unavailable', receipt?.paidAmount ?? null, submission.requestId);
  }

  const evaluation = evaluateChecks({
    receipt,
    merchantAccounts: tenantAccounts.map((a) => a.accountNumber),
    expectedAmount,
    // No order exists yet — "now" is the reference point, so the receipt
    // must be recent and not dated in the future (same semantics as the
    // order-time check against orders.created_at).
    orderCreatedAt: new Date().toISOString(),
    // The SELECT above already handled the other_order case; the
    // authoritative claim happens post-order in verify-order-payment.
    claimOutcome: { kind: 'not_attempted' },
    maxAgeHours: MAX_AGE_HOURS,
  });
  const checks = evaluation.checks;
  let verdict: Verdict;
  if (checks.recipientMatch?.result === 'fail') {
    verdict = 'wrong_recipient';
  } else if (checks.amountMatch?.result === 'fail') {
    verdict = 'wrong_amount';
  } else if (evaluation.overall === 'verified') {
    verdict = 'verified';
  } else {
    // receiptOwnership fail/review, masked-account review, incomplete
    // provider confirmation — non-conclusive, retryable, never a hard
    // rejection.
    verdict = 'unavailable';
  }
  return finish(verdict, receipt.paidAmount, submission.requestId);
});
