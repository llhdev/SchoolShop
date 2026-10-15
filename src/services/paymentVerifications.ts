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
