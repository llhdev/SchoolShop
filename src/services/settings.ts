// Platform-wide runtime settings (migration 042). The only flag today is the
// payment-verification kill-switch, readable by anyone and writable only by
// the super admin (RLS).

import { supabase } from '../lib/supabase';

/** Whether checkout must verify each shop's payment before placing the
 *  order. Fail toward true (require verification) when the read fails — the
 *  edge functions independently fail toward disabled, so a settings outage
 *  surfaces as retryable 'unavailable' verdicts rather than skipped checks. */
export async function fetchPaymentVerificationEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'payment_verification_enabled')
      .maybeSingle();
    if (error) {
      console.warn('payment verification flag read failed:', error.message);
      return true;
    }
    return data?.value === true;
  } catch {
    return true;
  }
}

/** Super-admin-only kill switch for the payment verification pipeline. */
export async function setPaymentVerificationEnabled(enabled: boolean): Promise<void> {
  const { error } = await supabase.from('platform_settings').upsert({
    key: 'payment_verification_enabled',
    value: enabled,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
