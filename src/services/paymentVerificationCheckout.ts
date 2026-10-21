// Pre-order payment verification: the checkout screen verifies each shop's
// payment reference against verify.et BEFORE the order exists, via the
// verify-payment-reference Edge Function (read-only — the authoritative claim
// still happens post-order in verify-order-payment). Shoppers are anonymous,
// so this calls the function URL directly with the anon key instead of the
// supabase client's authenticated RPC path.

export type ReferenceVerdict =
  | 'verified'
  | 'not_found'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'already_claimed'
  | 'unavailable';

export interface VerificationItem {
  productId: string;
  quantity: number;
  selectedOptions?: { group: string; option: string }[];
}

export interface VerifyPaymentReferenceArgs {
  tenantId: string;
  provider: 'cbe' | 'telebirr';
  reference: string;
  /** Idempotency key — stable per (proof, reference text) so verify.et bills
   *  a retry of the same reference for free. */
  key: string;
  /** Bare object path in payment-proofs-private returned by uploadPaymentProof. */
  proofRef: string;
  items: VerificationItem[];
}

export interface VerifyPaymentReferenceResult {
  verdict: ReferenceVerdict;
  paidAmount: number | null;
  expectedAmount: number;
  requestId: string | null;
  /** Server-provided reason behind the verdict (verify.et's error message or
   *  the failed/reviewed check reasons) — shown to the shopper so a fixable
   *  problem is distinguishable from a temporary outage. */
  detail: string | null;
}

const VERIFY_TIMEOUT_MS = 45_000;

const VALID_VERDICTS: ReferenceVerdict[] = [
  'verified',
  'not_found',
  'wrong_recipient',
  'wrong_amount',
  'already_claimed',
  'unavailable',
];

const UNAVAILABLE: VerifyPaymentReferenceResult = {
  verdict: 'unavailable',
  paidAmount: null,
  expectedAmount: 0,
  requestId: null,
  detail: null,
};

/** Verify one shop's payment reference before the order is placed. Network
 *  failures, timeouts, daily caps (429) and server errors all map to
 *  'unavailable' — a temporary, retryable state, never an invalid payment.
 *  A 400 means the client sent invalid input (a bug), surfaced as the same
 *  generic temporary failure. */
export async function verifyPaymentReference(
  args: VerifyPaymentReferenceArgs
): Promise<VerifyPaymentReferenceResult> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return UNAVAILABLE;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/verify-payment-reference`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Surface the server's error message (e.g. "proof not found") instead
      // of a bare generic failure.
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return { ...UNAVAILABLE, detail: body?.error ?? `HTTP ${response.status}` };
    }
    const data = (await response.json()) as Partial<VerifyPaymentReferenceResult>;
    if (!data.verdict || !VALID_VERDICTS.includes(data.verdict)) return UNAVAILABLE;
    return {
      verdict: data.verdict,
      paidAmount: data.paidAmount ?? null,
      expectedAmount: data.expectedAmount ?? 0,
      requestId: data.requestId ?? null,
      detail: data.detail ?? null,
    };
  } catch (error) {
    return { ...UNAVAILABLE, detail: `network error: ${String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

/** New idempotency key for a (proof, reference) pair. crypto.randomUUID is
 *  missing on some Hermes versions, hence the fallback — keys need
 *  uniqueness, not crypto strength. */
export function newVerificationKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
