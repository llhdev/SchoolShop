// Runtime kill-switch for the payment-verification pipeline: the super admin
// flips platform_settings.payment_verification_enabled (SQL editor or the
// admin UI switch) — no redeploy needed. Read fresh on every invocation;
// edge isolates are short-lived so this never goes stale.
//
// Fail-safe: a missing row or a read error counts as DISABLED, so an outage
// of the settings table never burns verify.et credits or sends Telegram
// verification messages.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';

export async function isVerificationEnabled(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'payment_verification_enabled')
    .maybeSingle();
  if (error) console.error('verification toggle read failed:', error);
  return data?.value === true;
}
