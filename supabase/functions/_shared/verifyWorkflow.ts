// Shared post-receipt workflow for payment verification: atomic claim,
// evaluation, attempt persistence and the merchant Telegram notification.
// Used by both verify-order-payment (synchronous path) and verify-et-webhook
// (async completion path) so the two never drift.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import {
  evaluateChecks,
  formatBirr,
  type CheckResult,
  type ClaimOutcome,
  type ParsedReceipt,
} from './verifyEvaluation.ts';

const CHECK_ICONS: Record<string, string> = { pass: '✔', review: '⚠', fail: '✘' };
const CHECK_TITLES: Record<string, string> = {
  paymentComplete: 'Payment completed',
  recipientMatch: 'Correct recipient',
  amountMatch: 'Exact amount',
  notPreviouslyClaimed: 'Not previously claimed',
  receiptOwnership: 'Receipt ownership',
};

export interface TenantProfile {
  id: string;
  shop_name: string | null;
  telegram_chat_id: string | null;
  bank_accounts: unknown;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildTelegramMessage(
  shopName: string,
  orderId: string,
  attemptNo: number,
  overall: string,
  checks: Record<string, CheckResult>,
  payer: string | null,
  transactionDate: string | null
): string {
  const headline =
    overall === 'verified'
      ? '✅ <b>Payment Verified</b>'
      : overall === 'needs_review'
        ? '⚠️ <b>Payment Needs Review</b>'
        : '❌ <b>Payment Verification Failed</b>';
  const lines = [
    headline,
    `🏪 ${escapeHtml(shopName)} · <code>#${escapeHtml(orderId.slice(0, 8))}</code> · attempt ${attemptNo}`,
    '',
  ];
  for (const [key, check] of Object.entries(checks)) {
    lines.push(`${CHECK_ICONS[check.result] ?? '•'} ${CHECK_TITLES[key] ?? key}: ${escapeHtml(check.reason)}`);
  }
  if (payer || transactionDate) {
    lines.push('');
    lines.push(
      `ℹ️ ${[payer ? `Payer: ${escapeHtml(payer)}` : '', transactionDate ? `Date: ${escapeHtml(transactionDate)}` : '']
        .filter(Boolean)
        .join(' · ')}`
    );
  }
  if (overall !== 'verified') {
    lines.push('', '<i>Review the proof in the order details before accepting.</i>');
  }
  return lines.join('\n');
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function notifyTenant(
  supabase: SupabaseClient,
  botToken: string,
  profile: TenantProfile,
  message: string
): Promise<void> {
  if (!botToken || !profile.telegram_chat_id) return;
  let result = await sendTelegram(botToken, profile.telegram_chat_id, message);
  if (!result.ok) {
    // A group upgraded to a supergroup gets a new chat id; adopt it and retry
    // once (same recovery as telegram-order-notify).
    const migrated = result.error?.match(/migrate_to_chat_id":(-?\d+)/)?.[1];
    if (migrated) {
      await supabase.from('profiles').update({ telegram_chat_id: migrated }).eq('id', profile.id);
      result = await sendTelegram(botToken, migrated, message);
    }
  }
  if (!result.ok) console.error(`verification telegram to ${profile.id} failed:`, result.error);
}

/** One atomic claim: exactly one concurrent claimant wins; the loser reads
 *  back the holder. Only ever called for fully passing payments (or manual
 *  approval, via the approve_payment_verification RPC). */
export async function attemptClaim(
  supabase: SupabaseClient,
  provider: string,
  reference: string,
  orderId: string,
  tenantId: string,
  verificationId: string
): Promise<ClaimOutcome> {
  const { data, error } = await supabase
    .from('payment_claims')
    .upsert(
      { provider, reference, order_id: orderId, tenant_id: tenantId, verification_id: verificationId },
      { onConflict: 'provider,reference', ignoreDuplicates: true }
    )
    .select('order_id');
  if (!error && data && data.length > 0) return { kind: 'claimed' };

  const { data: holder } = await supabase
    .from('payment_claims')
    .select('order_id')
    .eq('provider', provider)
    .eq('reference', reference)
    .maybeSingle();
  if (!holder) return { kind: 'claimed' };
  return holder.order_id === orderId
    ? { kind: 'same_order' }
    : { kind: 'other_order', holderOrderId: holder.order_id };
}

export interface CompleteAttemptInput {
  supabase: SupabaseClient;
  botToken: string;
  order: {
    id: string;
    created_at: string;
  };
  tenantId: string;
  profile: TenantProfile;
  attempt: { id: string; attempt_no: number; expected_amount: number | null };
  receipt: ParsedReceipt;
  payload: unknown;
  requestId: string | null;
  maxAgeHours: number;
}

/** Evaluate a completed receipt, claim when clean, persist, notify. */
export async function completeAttempt(input: CompleteAttemptInput): Promise<string> {
  const { supabase, botToken, order, tenantId, profile, attempt, receipt, payload, requestId, maxAgeHours } =
    input;

  const merchantAccounts = (Array.isArray(profile.bank_accounts) ? profile.bank_accounts : [])
    .map((a) => (a as { account_number?: string })?.account_number ?? '')
    .filter(Boolean);
  const baseInput = {
    receipt,
    merchantAccounts,
    expectedAmount: attempt.expected_amount ?? 0,
    orderCreatedAt: order.created_at,
    maxAgeHours,
  };

  // Claims are attempted only when the three hard checks pass on their own.
  const pre = evaluateChecks({ ...baseInput, claimOutcome: { kind: 'not_attempted' } });
  let claimOutcome: ClaimOutcome = { kind: 'not_attempted' };
  if (
    pre.checks.paymentComplete.result === 'pass' &&
    pre.checks.recipientMatch.result === 'pass' &&
    pre.checks.amountMatch.result === 'pass' &&
    receipt.provider &&
    receipt.reference
  ) {
    claimOutcome = await attemptClaim(supabase, receipt.provider, receipt.reference, order.id, tenantId, attempt.id);
  }
  const evaluation = evaluateChecks({ ...baseInput, claimOutcome });

  await supabase
    .from('payment_verifications')
    .update({
      status: evaluation.overall,
      checks: evaluation.checks,
      paid_amount: receipt.paidAmount,
      provider: receipt.provider,
      reference: receipt.reference,
      receiver_account: receipt.receiverAccount,
      payer: receipt.payer,
      transaction_date: receipt.transactionDate,
      request_id: requestId,
      raw: payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', attempt.id);

  const message = buildTelegramMessage(
    profile.shop_name ?? 'Shop',
    order.id,
    attempt.attempt_no,
    evaluation.overall,
    evaluation.checks,
    receipt.payer,
    receipt.transactionDate
  );
  await notifyTenant(supabase, botToken, profile, message);
  return evaluation.overall;
}

// re-export so callers import from one place
export { formatBirr };
