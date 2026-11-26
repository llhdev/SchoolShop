// Payment verification (verify.et, migration 040): merchant-facing reads and
// actions on payment_verifications. Reads are RLS-scoped — a tenant admin only
// ever receives their own rows, the super admin receives every row. Retry and
// approve go through SECURITY DEFINER RPCs; the client never calls the
// verify-order-payment Edge Function directly.
import { supabase } from '../lib/supabase';
import { PaymentVerification, VerificationCheck, VerificationStatus } from '../types';

interface VerificationRow {
  id: string;
  order_id: string;
  tenant_id: string;
  attempt_no: number;
  status: VerificationStatus;
  checks: Record<string, VerificationCheck> | null;
  expected_amount: number | null;
  paid_amount: number | null;
  provider: string | null;
  reference: string | null;
  receiver_account: string | null;
  payer: string | null;
  transaction_date: string | null;
  updated_at: string;
}

function mapVerification(row: VerificationRow): PaymentVerification {
  return {
    id: row.id,
    orderId: row.order_id,
    tenantId: row.tenant_id,
    attemptNo: row.attempt_no,
    status: row.status,
    checks: row.checks ?? {},
    expectedAmount: row.expected_amount,
    paidAmount: row.paid_amount,
    provider: row.provider,
    reference: row.reference,
    receiverAccount: row.receiver_account,
    payer: row.payer,
    transactionDate: row.transaction_date,
    updatedAt: row.updated_at,
  };
}

/** Current verification attempt for each given order (one per merchant). */
export async function fetchVerificationsForOrders(orderIds: string[]): Promise<PaymentVerification[]> {
  if (orderIds.length === 0) return [];
  const { data, error } = await supabase
    .from('payment_verifications')
    .select('*')
    .in('order_id', orderIds)
    .eq('is_current', true);
  if (error) throw new Error(error.message);
  return ((data ?? []) as VerificationRow[]).map(mapVerification);
}

/** Refetch trigger so a verification completing while an admin screen is open
 *  refreshes without a reload. Volume is low, so any change refetches. */
export function subscribeToVerifications(onChange: () => void) {
  const channel = supabase
    .channel(`payment-verifications-${Date.now()}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'payment_verifications' },
      () => onChange()
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

/** Re-run verification for one merchant's proof (replacement screenshot, error
 *  recovery, stale pending). Super admin or the owning tenant only. */
export async function retryPaymentVerification(orderId: string, tenantId: string): Promise<void> {
  const { error } = await supabase.rpc('retry_payment_verification', {
    p_order_id: orderId,
    p_tenant_id: tenantId,
  });
  if (error) throw new Error(error.message);
}

/** Merchant authority for needs_review results: claims the reference
 *  atomically and marks the current attempt verified. */
export async function approvePaymentVerification(orderId: string, tenantId: string): Promise<void> {
  const { error } = await supabase.rpc('approve_payment_verification', {
    p_order_id: orderId,
    p_tenant_id: tenantId,
  });
  if (error) throw new Error(error.message);
}

/** Record a transaction reference manually (migration 067) — for orders whose
 *  proof couldn't be verified automatically (payment warning), so the
 *  financial admin types the reference off the receipt image. The server
 *  validates the provider/format, stores it on the order, and claims it
 *  atomically — a reference already used by another order is rejected. */
export async function setOrderPaymentReference(
  orderId: string,
  tenantId: string,
  provider: 'cbe' | 'telebirr',
  reference: string
): Promise<void> {
  const { error } = await supabase.rpc('set_order_payment_reference', {
    p_order_id: orderId,
    p_tenant_id: tenantId,
    p_provider: provider,
    p_reference: reference,
  });
  if (error) throw new Error(error.message);
}

export type ManualVerifyResult =
  | { ok: true; alreadyVerified: boolean }
  | { ok: false; reasons: string[] };

/** Verify a manually typed transaction reference via the
 *  manual-verify-reference Edge Function (super admin, or the shop's
 *  financial or branch staff — the function authorizes the caller's profile
 *  and capability; branch callers since 073 are auto-paid only on their
 *  branch's scoped items). On success the server records the reference (key
 *  'manual'), marks the current attempt verified, claims the transaction,
 *  clears the shop's payment warning (branch: only when nothing stays
 *  pending/received), and auto-pays the scoped pending/received items.
 *  Definitive failed/needs_review verdicts persist as the current attempt;
 *  transient failures persist nothing; transport/server errors throw. */
export async function manualVerifyReference(
  orderId: string,
  tenantId: string,
  provider: 'cbe' | 'telebirr',
  reference: string
): Promise<ManualVerifyResult> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!supabaseUrl || !anonKey || !token) {
    throw new Error('Sign in as an admin to verify payments.');
  }
  const response = await fetch(`${supabaseUrl}/functions/v1/manual-verify-reference`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderId, tenantId, provider, reference }),
  });
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; alreadyVerified?: boolean; reasons?: unknown; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Could not verify the payment (HTTP ${response.status}).`);
  }
  if (body?.ok === true) return { ok: true, alreadyVerified: body.alreadyVerified === true };
  const reasons = Array.isArray(body?.reasons)
    ? body.reasons.filter((r): r is string => typeof r === 'string')
    : [];
  return { ok: false, reasons: reasons.length > 0 ? reasons : ['The transaction could not be confirmed.'] };
}
