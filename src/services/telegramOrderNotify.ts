import { Order } from '../types';

/**
 * Post a newly placed order to the shop's Telegram group via the
 * telegram-order-notify Edge Function. Best-effort: any failure (offline,
 * function misconfigured) is swallowed so it never affects order placement —
 * but it IS logged to the console so a broken pipeline shows up in devtools
 * instead of failing silently (as it did in the Oct 2026 outage).
 *
 * The function itself is gated by the anon/publishable key header; the bot
 * token and group chat id live only in Supabase secrets.
 */
export function notifyTelegramOrder(
  order: Order,
  telegramUser?: { firstName?: string; lastName?: string; username?: string }
): Promise<void> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return Promise.resolve();

  return fetch(`${supabaseUrl}/functions/v1/telegram-order-notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({
      id: order.id,
      items: order.items,
      total: order.total,
      payment_method: order.paymentMethod,
      status: order.status,
      location: order.location,
      phone_number: order.phoneNumber,
      telegram_id: order.telegramId ?? null,
      created_at: order.createdAt,
      payment_proofs: order.paymentProofs ?? {},
      shipping_fees: order.shippingFees ?? {},
      telegram_user: telegramUser
        ? {
            first_name: telegramUser.firstName,
            last_name: telegramUser.lastName,
            username: telegramUser.username,
          }
        : undefined,
    }),
  })
    .then(async (res) => {
      if (!res.ok) {
        console.warn(
          `[telegramOrderNotify] notify failed: HTTP ${res.status}`,
          await res.text().catch(() => '')
        );
        return;
      }
      // The function reports per-shop delivery in its body; surface skips so
      // a misconfigured tenant (missing chat id, Telegram rejection) is
      // visible without opening the Supabase logs.
      const body = await res.json().catch(() => null);
      if (body && Array.isArray(body.skipped) && body.skipped.length > 0) {
        console.warn('[telegramOrderNotify] some shops were not notified:', body.skipped);
      }
    })
    .catch((error) => {
      console.warn('[telegramOrderNotify] notify request failed:', error);
    });
}
