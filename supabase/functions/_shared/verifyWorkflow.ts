// Shared post-receipt workflow for payment verification: atomic claim,
// evaluation, attempt persistence, auto-pay on verified, and the INLINE edit
// of the merchant's Telegram order message. Used by both
// verify-order-payment (synchronous path) and verify-et-webhook (async
// completion path) so the two never drift.
//
// There is NO separate verification message: the per-shop order message sent
// by telegram-order-notify carries the state inline (⚠️ line at send time for
// warning passes), and a verification completing later flips that line to
// ✅ Payment Verified via editMessageCaption/editMessageText on the locator
// stored in orders.telegram_notifications (migration 057).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import {
  evaluateChecks,
  formatBirr,
  type ClaimOutcome,
  type ParsedReceipt,
} from './verifyEvaluation.ts';

export interface TenantProfile {
  id: string;
  shop_name: string | null;
  telegram_chat_id: string | null;
  bank_accounts: unknown;
  shipping_fee?: number | null;
  /** 069: receipts dated before this hard-fail (pre-verification era). */
  payment_verification_started_at?: string | null;
}

/** Exact inline lines of the per-shop order message (also produced by
 *  buildSummary in telegram-order-notify — the texts must stay in sync:
 *  the edit below matches the warning line literally). */
const WARNING_LINE = '⚠️ Payment unconfirmed — check proof';
const VERIFIED_LINE = '✅ Payment Verified';
/** Telegram captions cap at 1024 chars; message text at 4096. */
const CAPTION_LIMIT = 1024;

interface TelegramNotificationEntry {
  chat_id?: unknown;
  message_id?: unknown;
  kind?: unknown;
  text?: unknown;
}

async function postTelegram(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Late verification rides INLINE in the per-shop order message that
 *  telegram-order-notify already sent: the stored caption/message text gains
 *  the ✅ Payment Verified line (replacing the checkout-time ⚠️ warning line
 *  when present). The Bot API cannot read a caption back, so the exact text
 *  sent is stored alongside the locator in orders.telegram_notifications
 *  (057) and the new text is reconstructed from it.
 *  Entry missing (bot down at order time, order predates 057) → log and
 *  skip: the admin UI badge carries the state. All failures are logged,
 *  never thrown. */
async function markOrderMessageVerified(
  supabase: SupabaseClient,
  botToken: string,
  orderId: string,
  tenantId: string
): Promise<void> {
  if (!botToken) return;
  const { data, error } = await supabase
    .from('orders')
    .select('telegram_notifications')
    .eq('id', orderId)
    .single();
  if (error) {
    console.error(`telegram_notifications load failed for order ${orderId}:`, error.message);
    return;
  }
  const notifications =
    data?.telegram_notifications &&
    typeof data.telegram_notifications === 'object' &&
    !Array.isArray(data.telegram_notifications)
      ? (data.telegram_notifications as Record<string, TelegramNotificationEntry>)
      : {};
  const entry = notifications[tenantId];
  const chatId = typeof entry?.chat_id === 'number' ? entry.chat_id : null;
  const messageId = typeof entry?.message_id === 'number' ? entry.message_id : null;
  if (!entry || chatId === null || messageId === null) {
    console.log(
      `no telegram message locator for order ${orderId} tenant ${tenantId}; skipping inline edit`
    );
    return;
  }

  const oldText = typeof entry.text === 'string' ? entry.text : '';
  const newText = oldText.includes(WARNING_LINE)
    ? oldText.replace(WARNING_LINE, VERIFIED_LINE)
    : oldText
      ? `${oldText}\n${VERIFIED_LINE}`
      : VERIFIED_LINE;
  const isCaption = entry.kind === 'photo' || entry.kind === 'album' || entry.kind === 'document';
  if (isCaption && newText.length > CAPTION_LIMIT) {
    console.log(
      `caption edit for order ${orderId} tenant ${tenantId} would exceed ${CAPTION_LIMIT} chars; skipping`
    );
    return;
  }

  const method = isCaption ? 'editMessageCaption' : 'editMessageText';
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    ...(isCaption
      ? { caption: newText }
      : { text: newText, disable_web_page_preview: true }),
  };
  let result = await postTelegram(botToken, method, body);
  if (!result.ok) {
    // A group upgraded to a supergroup gets a new chat id; adopt it (profile
    // AND stored locator, since future edits read it) and retry once — same
    // recovery as telegram-order-notify.
    const migrated = result.error?.match(/migrate_to_chat_id":(-?\d+)/)?.[1];
    if (migrated) {
      await supabase.from('profiles').update({ telegram_chat_id: migrated }).eq('id', tenantId);
      const migratedChatId = Number(migrated);
      if (Number.isFinite(migratedChatId)) {
        await supabase
          .from('orders')
          .update({
            telegram_notifications: {
              ...notifications,
              [tenantId]: { ...entry, chat_id: migratedChatId },
            },
          })
          .eq('id', orderId);
        result = await postTelegram(botToken, method, { ...body, chat_id: migratedChatId });
      }
    }
  }
  if (!result.ok) {
    console.error(`telegram ${method} for order ${orderId} tenant ${tenantId} failed:`, result.error);
  } else {
    console.log(`order ${orderId} tenant ${tenantId}: telegram message ${messageId} marked verified`);
  }
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
  if (holder) {
    return holder.order_id === orderId
      ? { kind: 'same_order' }
      : { kind: 'other_order', holderOrderId: holder.order_id };
  }
  if (error) {
    // Fail closed: a transient DB error must NOT record a phantom claim —
    // the caller catches this and marks the attempt retryable instead.
    throw new Error(`claim insert failed: ${error.message}`);
  }
  return { kind: 'claimed' };
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

const LIFECYCLE = ['pending', 'received', 'paid', 'on_the_way', 'completed'] as const;

interface OrderLineItem {
  product?: { id?: unknown; owner_id?: unknown; ownerId?: unknown };
  selectedImageIndex?: unknown;
  selectedOptions?: unknown;
}

/** Line-item key, exactly matching the client's getCartItemLineId and the
 *  update_order_item_status SQL: "productId:imageIndex" plus
 *  ":Group=Option|…" when the line carries variant selections. */
function lineItemKey(item: OrderLineItem): string | null {
  const productId = item.product?.id;
  if (typeof productId !== 'string' || !productId) return null;
  let key = `${productId}:${typeof item.selectedImageIndex === 'number' ? item.selectedImageIndex : 0}`;
  const options = Array.isArray(item.selectedOptions)
    ? (item.selectedOptions as { group?: unknown; option?: unknown }[])
    : [];
  if (options.length > 0) {
    key += ':' + options.map((o) => `${o?.group}=${o?.option}`).join('|');
  }
  return key;
}

/** Auto-pay on verified (soft launch): a fully verified payment moves the
 *  tenant's own pending/received line items straight to 'paid'; items already
 *  further along (on_the_way/completed/cancelled) and other tenants' items
 *  are left alone, and the order-level status is recomputed the same way
 *  update_order_item_status does. Warned/inconclusive verdicts never reach
 *  here — those orders follow the manual staff flow. */
async function autoPayVerifiedItems(
  supabase: SupabaseClient,
  orderId: string,
  tenantId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('orders')
    .select('items, item_statuses, status')
    .eq('id', orderId)
    .single();
  if (error) throw new Error(`order load failed: ${error.message}`);

  const items = Array.isArray(data?.items) ? (data.items as OrderLineItem[]) : [];
  const statuses: Record<string, string> =
    data?.item_statuses && typeof data.item_statuses === 'object' && !Array.isArray(data.item_statuses)
      ? { ...(data.item_statuses as Record<string, string>) }
      : {};
  const orderStatus = typeof data?.status === 'string' ? data.status : 'pending';

  let changed = 0;
  for (const item of items) {
    if ((item.product?.owner_id ?? item.product?.ownerId) !== tenantId) continue;
    const key = lineItemKey(item);
    if (!key) continue;
    const effective = statuses[key] ?? orderStatus;
    if (effective === 'pending' || effective === 'received') {
      statuses[key] = 'paid';
      changed += 1;
    }
  }
  if (changed === 0) return;

  // Recompute the order-level status as the least-advanced non-cancelled item
  // status over ALL items; every item cancelled ⇒ the order is cancelled.
  let minOrd: number | null = null;
  let sawNonCancelled = false;
  for (const item of items) {
    const key = lineItemKey(item);
    if (!key) continue;
    const effective = statuses[key] ?? orderStatus;
    if (effective === 'cancelled') continue;
    sawNonCancelled = true;
    const ord = (LIFECYCLE as readonly string[]).indexOf(effective);
    if (ord >= 0 && (minOrd === null || ord < minOrd)) minOrd = ord;
  }
  const newStatus = !sawNonCancelled ? 'cancelled' : minOrd !== null ? LIFECYCLE[minOrd] : orderStatus;

  const { error: updateError } = await supabase
    .from('orders')
    .update({ item_statuses: statuses, status: newStatus })
    .eq('id', orderId);
  if (updateError) throw new Error(`auto-pay update failed: ${updateError.message}`);
  console.log(`auto-pay: marked ${changed} item(s) paid on order ${orderId} for tenant ${tenantId}`);
}

/** Evaluate a completed receipt, claim when clean, persist, sync Telegram. */
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
    verificationStartedAt: profile.payment_verification_started_at ?? null,
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

  // Auto-pay on verified only: warned (needs_review) or failed verdicts keep
  // the manual staff flow. Any failure here is logged and swallowed — it must
  // never fail or roll back the verification write above.
  if (evaluation.overall === 'verified') {
    try {
      await autoPayVerifiedItems(supabase, order.id, tenantId);
    } catch (error) {
      console.error(`auto-pay failed for order ${order.id}:`, error);
    }
  }

  // Verified verdicts also flip the inline payment line of the per-shop order
  // message telegram-order-notify sent (locator + text in
  // orders.telegram_notifications, 057) — never a second message. Same
  // swallow-errors discipline as auto-pay above.
  if (evaluation.overall === 'verified') {
    try {
      await markOrderMessageVerified(supabase, botToken, order.id, tenantId);
    } catch (error) {
      console.error(`telegram inline-verify edit failed for order ${order.id}:`, error);
    }
  }
  return evaluation.overall;
}

// re-export so callers import from one place
export { formatBirr };
