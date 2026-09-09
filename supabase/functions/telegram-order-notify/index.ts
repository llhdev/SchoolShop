// Posts a newly placed order to the shop's Telegram group: an order summary
// plus cover images of each ordered item (as a photo album). Called by the
// client right after a successful order insert (fire-and-forget) — the bot
// token stays server-side.
//
// Required secrets (Supabase Dashboard > Edge Functions > Secrets):
//   TELEGRAM_BOT_TOKEN    — from @BotFather (already set for telegram-auth)
//   TELEGRAM_ORDER_CHAT_ID — the group's chat id (negative number, e.g.
//                            -1001234567890). Without it the function logs
//                            and returns { notified: false }.
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically.

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CHAT_ID = Deno.env.get('TELEGRAM_ORDER_CHAT_ID') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_ALBUM_PHOTOS = 10;

interface OrderItem {
  product?: {
    name?: string;
    price?: number;
    images?: string[];
    coverImageIndex?: number;
  };
  quantity?: number;
  selectedImageIndex?: number;
}

interface OrderPayload {
  id?: string;
  items?: OrderItem[];
  total?: number;
  payment_method?: string;
  status?: string;
  location?: string;
  phone_number?: string;
  telegram_id?: number | null;
  created_at?: string;
  telegram_user?: { first_name?: string; last_name?: string; username?: string };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBirr(amount: number): string {
  return `${Math.round(amount).toLocaleString('en-US')} ETB`;
}

function itemCoverUrl(item: OrderItem): string | null {
  const images = item.product?.images;
  if (!images || images.length === 0) return null;
  const selected = item.selectedImageIndex;
  const cover = item.product?.coverImageIndex ?? 0;
  const index =
    typeof selected === 'number' && selected >= 0 && selected < images.length
      ? selected
      : Math.min(Math.max(cover, 0), images.length - 1);
  return images[index] ?? images[0] ?? null;
}

function buildSummary(order: OrderPayload): string {
  const lines: string[] = [];
  lines.push('<b>🛒 New Order</b>');
  if (order.id) lines.push(`<code>#${escapeHtml(order.id.slice(0, 8))}</code>`);
  if (order.created_at) {
    const date = new Date(order.created_at);
    if (!Number.isNaN(date.getTime())) {
      lines.push(
        `🕒 ${date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
      );
    }
  }
  lines.push('');
  if (order.phone_number) lines.push(`📞 ${escapeHtml(order.phone_number)}`);
  if (order.location) lines.push(`📍 ${escapeHtml(order.location)}`);
  lines.push(
    `💳 ${
      order.payment_method === 'cash_on_delivery'
        ? 'Cash on Delivery'
        : 'Online Payment'
    }`
  );
  if (order.telegram_id) {
    const tg = order.telegram_user;
    const name = tg ? [tg.first_name, tg.last_name].filter(Boolean).join(' ') : '';
    const username = tg?.username ? `@${tg.username.replace(/^@/, '')}` : '';
    const who = [name, username].filter(Boolean).join(' ');
    lines.push(`✈️ Telegram user${who ? `: ${escapeHtml(who)}` : ''}`);
  }
  lines.push('');
  for (const item of order.items ?? []) {
    const name = item.product?.name ?? 'Item';
    const price = item.product?.price ?? 0;
    const qty = item.quantity ?? 1;
    lines.push(
      `• ${qty} × ${escapeHtml(name)} — <b>${formatBirr(price * qty)}</b>`
    );
  }
  if (typeof order.total === 'number') {
    lines.push('');
    lines.push(`<b>Total: ${formatBirr(order.total)}</b>`);
  }
  return lines.join('\n');
}

async function sendTelegram(method: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`telegram ${method} failed:`, res.status, await res.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error(`telegram ${method} error:`, error);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Light auth gate: caller must present the anon key (public, but keeps
  // random internet traffic from borrowing our bot to spam chats).
  const auth = req.headers.get('authorization') ?? '';
  if (!ANON_KEY || auth !== `Bearer ${ANON_KEY}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let order: OrderPayload;
  try {
    order = (await req.json()) as OrderPayload;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN secret is not set');
    return json({ notified: false, reason: 'bot token not configured' });
  }
  if (!CHAT_ID) {
    console.error('TELEGRAM_ORDER_CHAT_ID secret is not set');
    return json({ notified: false, reason: 'chat id not configured' });
  }

  const summary = buildSummary(order);

  // Cover image of each line item, deduped, capped at Telegram's album limit.
  const urls: string[] = [];
  for (const item of order.items ?? []) {
    const url = itemCoverUrl(item);
    if (url && !urls.includes(url)) urls.push(url);
  }
  const photos = urls.slice(0, MAX_ALBUM_PHOTOS);

  let notified = false;
  if (photos.length > 0) {
    notified = await sendTelegram('sendMediaGroup', {
      chat_id: CHAT_ID,
      media: photos.map((url, index) => ({
        type: 'photo',
        media: url,
        ...(index === 0 ? { caption: summary, parse_mode: 'HTML' } : {}),
      })),
    });
  }
  if (!notified) {
    // No images, album rejected, or Telegram could not fetch a URL:
    // fall back to a plain text summary so the order is never lost.
    notified = await sendTelegram('sendMessage', {
      chat_id: CHAT_ID,
      text: summary,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  return json({ notified });
});
