import { Order } from '../types';

/**
 * Post a newly placed order to the shop's Telegram group via the
 * telegram-order-notify Edge Function. Best-effort: any failure (offline,
 * function misconfigured) is swallowed so it never affects order placement.
 *
 * The function itself is gated by the anon key header; the bot token and
 * group chat id live only in Supabase secrets.
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
      telegram_user: telegramUser
        ? {
            first_name: telegramUser.firstName,
            last_name: telegramUser.lastName,
            username: telegramUser.username,
          }
        : undefined,
    }),
  })
    .then(() => {})
    .catch(() => {});
}
