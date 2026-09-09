import { Shopper } from '../types';

/**
 * Exchange signed Telegram Mini App initData for the shopper record.
 * The Edge Function validates the HMAC signature with the bot token, so the
 * returned identity is trustworthy (unlike anything the client could claim).
 */
export async function authenticateTelegramShopper(
  initData: string
): Promise<Shopper | null> {
  if (!initData) return null;
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return null;

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/telegram-auth`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      }
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      shopper?: {
        telegram_id: number;
        first_name: string;
        last_name: string | null;
        username: string | null;
      };
    };
    const row = data.shopper;
    if (!row) return null;

    return {
      telegramId: row.telegram_id,
      firstName: row.first_name,
      lastName: row.last_name ?? undefined,
      username: row.username ?? undefined,
    };
  } catch {
    // Offline or unreachable: the caller keeps any cached shopper.
    return null;
  }
}
