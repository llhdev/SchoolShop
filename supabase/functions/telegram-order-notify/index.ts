// Routes a newly placed order to each tenant's Telegram group: every shop that
// owns at least one ordered item gets a summary + cover images of THEIR items
// plus THEIR payment proof photo (orders.payment_proofs, migration 020)
// (order id, customer phone/location are shared — it's one delivery).
// Tenants without a configured group chat id are skipped and reported.
// Called by the client right after a successful order insert (fire-and-forget)
// — the bot token stays server-side.
//
// Required secrets (Supabase Dashboard > Edge Functions > Secrets):
//   TELEGRAM_BOT_TOKEN — from @BotFather (already set for telegram-auth)
//   PUBLISHABLE_KEY    — the project's sb_publishable_… API key; accepted by
//                        the auth gate alongside the legacy anon JWT (web builds
//                        since Oct 2026 send the publishable key).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
// automatically. The service role reads profiles.telegram_chat_id (profiles
// is not anon-readable).
//
// Per-tenant chat ids are managed by the super admin in the app's Tenant
// Management screen (profiles.telegram_chat_id, migration 018).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { R2_PROOFS_BUCKET, presign, r2Configured, signedRequest } from '../_shared/r2Sign.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// The web build moved to Supabase's new publishable API key (sb_publishable_…);
// accept it alongside the legacy anon JWT so old and new clients both pass the
// auth gate below. Set with: supabase secrets set PUBLISHABLE_KEY=sb_publishable_…
const PUBLISHABLE_KEY = Deno.env.get('PUBLISHABLE_KEY') ?? '';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_ALBUM_PHOTOS = 10;
/** attach:// name for the payment proof when sent as uploaded bytes. */
const PROOF_ATTACH_NAME = 'payment_proof.jpg';

interface OrderItem {
  product?: {
    id?: string;
    name?: string;
    price?: number;
    images?: string[];
    coverImageIndex?: number;
    /** Stamped server-side by the stamp_order_tenants trigger (migration 018). */
    owner_id?: string;
    /** Client-side camelCase, present when the cart held fresh product data. */
    ownerId?: string;
    shop_name?: string;
    shopName?: string;
  };
  quantity?: number;
  selectedImageIndex?: number;
  /** Chosen variant options (migration 035). */
  selectedOptions?: { group: string; option: string }[];
  /** Unit price snapshotted at checkout (variant price); falls back to product price. */
  unitPrice?: number;
  /** Buyer's answers to the tenant's checkout questions (migration 036). */
  fieldAnswers?: { label?: string; value?: string }[];
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
  /** Shopper's payment proof photos, keyed by tenant owner id (migration 020).
   *  Each tenant receives the proof for THEIR slice of the order. */
  payment_proofs?: Record<string, string>;
  /** Per-shop shipping fees charged at checkout, keyed by tenant owner id
   *  (migration 031). Added once to the tenant's slice total. */
  shipping_fees?: Record<string, number>;
  telegram_user?: { first_name?: string; last_name?: string; username?: string };
}

interface TenantTarget {
  ownerId: string;
  shopName: string;
  chatId: string;
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

function itemOwnerId(item: OrderItem): string | null {
  return item.product?.owner_id ?? item.product?.ownerId ?? null;
}

function itemShopName(item: OrderItem): string | null {
  return item.product?.shop_name ?? item.product?.shopName ?? null;
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

/** Line items subtotal for one tenant's slice of the order. */
function sliceTotal(items: OrderItem[]): number {
  return items.reduce(
    (sum, item) => sum + (item.unitPrice ?? item.product?.price ?? 0) * (item.quantity ?? 1),
    0
  );
}

function buildSummary(
  order: OrderPayload,
  shopName: string,
  items: OrderItem[],
  shippingFee: number
): string {
  const lines: string[] = [];
  lines.push('<b>🛒 New Order</b>');
  lines.push(`🏪 ${escapeHtml(shopName)}`);
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
  lines.push('💳 Bank Transfer');
  if (order.telegram_id) {
    const tg = order.telegram_user;
    const name = tg ? [tg.first_name, tg.last_name].filter(Boolean).join(' ') : '';
    const username = tg?.username ? `@${tg.username.replace(/^@/, '')}` : '';
    const who = [name, username].filter(Boolean).join(' ');
    lines.push(`✈️ Telegram user${who ? `: ${escapeHtml(who)}` : ''}`);
  }
  lines.push('');
  for (const item of items) {
    const baseName = item.product?.name ?? 'Item';
    const variant = (item.selectedOptions ?? [])
      .map((o) => `${o.group} ${o.option}`)
      .join(' · ');
    const name = variant ? `${baseName} — ${variant}` : baseName;
    const price = item.unitPrice ?? item.product?.price ?? 0;
    const qty = item.quantity ?? 1;
    lines.push(
      `• ${qty} × ${escapeHtml(name)} — <b>${formatBirr(price * qty)}</b>`
    );
    for (const answer of item.fieldAnswers ?? []) {
      if (answer.label && answer.value) {
        lines.push(`   — ${escapeHtml(answer.label)}: ${escapeHtml(answer.value)}`);
      }
    }
  }
  if (shippingFee > 0) {
    lines.push(`🚚 Shipping — <b>${formatBirr(shippingFee)}</b>`);
  }
  lines.push('');
  lines.push(`<b>Total: ${formatBirr(sliceTotal(items) + shippingFee)}</b>`);
  return lines.join('\n');
}

interface SendResult {
  ok: boolean;
  /** Telegram's error detail — surfaced in the function's JSON response so
   *  delivery failures are diagnosable without digging through logs. */
  error?: string;
  /** Non-fatal problem (e.g. images dropped, text summary still delivered).
   *  Surfaced on the notified entry so degraded deliveries are visible. */
  warning?: string;
}

/** Proofs live in the PRIVATE R2 bucket (bare object paths on
 *  orders.payment_proofs) and are resolved through a short-lived presigned
 *  R2 URL, then downloaded and re-uploaded to Telegram as bytes (attach://)
 *  because Telegram's fetcher intermittently fails on R2 URLs. Proofs not
 *  yet migrated fall back to a signed URL from the legacy Supabase bucket.
 *  Legacy rows hold full public URLs. */
const PROOFS_BUCKET = 'payment-proofs-private';

async function resolveProofUrl(
  supabase: SupabaseClient,
  ref: string
): Promise<string | null> {
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  if (r2Configured()) {
    const head = await signedRequest('HEAD', R2_PROOFS_BUCKET, ref);
    if (head.ok) return presign('GET', R2_PROOFS_BUCKET, ref, 3600);
  }
  const { data, error } = await supabase.storage.from(PROOFS_BUCKET).createSignedUrl(ref, 3600);
  if (error) {
    console.error('failed to sign proof url:', error.message ?? error);
    return null;
  }
  return data.signedUrl;
}

async function sendTelegram(method: string, payload: unknown): Promise<SendResult> {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`telegram ${method} failed:`, res.status, body);
      return { ok: false, error: `${method} ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (error) {
    console.error(`telegram ${method} error:`, error);
    return { ok: false, error: `${method} threw: ${String(error)}` };
  }
}

/** Multipart variant for sending the payment proof as uploaded bytes
 *  (attach://) instead of a URL Telegram must fetch. Telegram's fetcher
 *  intermittently fails on presigned R2 URLs (WEBPAGE_CURL_FAILED), which
 *  used to reject the whole album — uploading the bytes removes that
 *  dependency entirely. The file field name must match the attach:// name
 *  used in the payload. */
async function sendTelegramWithProof(
  method: string,
  fields: Record<string, string>,
  proofBytes: ArrayBuffer
): Promise<SendResult> {
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append(PROOF_ATTACH_NAME, new Blob([proofBytes], { type: 'image/jpeg' }), PROOF_ATTACH_NAME);
    const res = await fetch(`${API}/${method}`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text();
      console.error(`telegram ${method} (multipart) failed:`, res.status, body);
      return { ok: false, error: `${method} ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (error) {
    console.error(`telegram ${method} (multipart) error:`, error);
    return { ok: false, error: `${method} threw: ${String(error)}` };
  }
}

async function sendToTenant(
  supabase: SupabaseClient,
  target: TenantTarget,
  order: OrderPayload,
  items: OrderItem[]
): Promise<SendResult> {
  const shippingFee = order.shipping_fees?.[target.ownerId] ?? 0;
  const summary = buildSummary(order, target.shopName, items, shippingFee);

  // Cover image of each line item, deduped. One album slot is reserved for
  // the payment proof below, so the cap is applied to item photos only.
  const urls: string[] = [];
  for (const item of items) {
    const url = itemCoverUrl(item);
    if (url && !urls.includes(url)) urls.push(url);
  }
  const photos = urls.slice(0, MAX_ALBUM_PHOTOS - 1);

  // The tenant's payment proof rides in the SAME message as the order — it is
  // simply the last photo of the album, no separate message or caption.
  // The proof is DOWNLOADED here and uploaded to Telegram as bytes
  // (attach://): Telegram's fetcher intermittently fails on presigned R2
  // URLs (WEBPAGE_CURL_FAILED), which rejected the whole album. If the
  // download fails, the proof falls back to riding as a URL (legacy
  // behavior) so it still has a chance to arrive.
  const proofRef = order.payment_proofs?.[target.ownerId];
  let proofUrl: string | null = null;
  let proofBytes: ArrayBuffer | null = null;
  if (proofRef) {
    proofUrl = await resolveProofUrl(supabase, proofRef);
    if (proofUrl) {
      try {
        const res = await fetch(proofUrl);
        if (res.ok) {
          proofBytes = await res.arrayBuffer();
        } else {
          console.error(`proof download failed (HTTP ${res.status}), falling back to URL`);
        }
      } catch (error) {
        console.error('proof download error, falling back to URL:', error);
      }
    }
  }

  interface MediaItem {
    type: 'photo';
    media: string;
    caption?: string;
    parse_mode?: 'HTML';
  }
  const media: MediaItem[] = photos.map((url, index) => ({
    type: 'photo',
    media: url,
    ...(index === 0 ? { caption: summary, parse_mode: 'HTML' as const } : {}),
  }));
  if (proofBytes) {
    media.push({
      type: 'photo',
      media: `attach://${PROOF_ATTACH_NAME}`,
      ...(media.length === 0 ? { caption: summary, parse_mode: 'HTML' as const } : {}),
    });
  } else if (proofUrl) {
    media.push({
      type: 'photo',
      media: proofUrl,
      ...(media.length === 0 ? { caption: summary, parse_mode: 'HTML' as const } : {}),
    });
  }

  const errors: string[] = [];
  if (media.length === 1) {
    // Albums require 2-10 items — a lone photo goes through sendPhoto.
    const only = media[0];
    const single =
      proofBytes && only.media.startsWith('attach://')
        ? await sendTelegramWithProof(
            'sendPhoto',
            {
              chat_id: target.chatId,
              photo: only.media,
              caption: summary,
              parse_mode: 'HTML',
            },
            proofBytes
          )
        : await sendTelegram('sendPhoto', {
            chat_id: target.chatId,
            photo: only.media,
            caption: summary,
            parse_mode: 'HTML',
          });
    if (single.ok) return { ok: true };
    errors.push(single.error ?? 'sendPhoto failed');
  } else if (media.length > 1) {
    const album = proofBytes
      ? await sendTelegramWithProof(
          'sendMediaGroup',
          { chat_id: target.chatId, media: JSON.stringify(media) },
          proofBytes
        )
      : await sendTelegram('sendMediaGroup', {
          chat_id: target.chatId,
          media,
        });
    if (album.ok) return { ok: true };
    errors.push(album.error ?? 'sendMediaGroup failed');
  }
  // No images, album rejected, or Telegram could not fetch a URL:
  // fall back to a plain text summary so the order is never lost. The
  // failure is reported as a warning — the delivery is degraded (no
  // images), not lost, and hiding it is how the Nov 2026 outage went
  // unnoticed.
  const text = await sendTelegram('sendMessage', {
    chat_id: target.chatId,
    text: summary,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  if (text.ok) {
    return errors.length > 0
      ? { ok: true, warning: `images dropped (${errors.join(' | ')}), sent text only` }
      : { ok: true };
  }
  errors.push(text.error ?? 'sendMessage failed');

  return { ok: false, error: errors.join(' | ') };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Light auth gate: caller must present a recognized public key (keeps random
  // internet traffic from borrowing our bot to spam chats). Accepts both the
  // legacy anon JWT and the new sb_publishable_ key so old and new client
  // builds keep working.
  const auth = req.headers.get('authorization') ?? '';
  const allowed = [ANON_KEY, PUBLISHABLE_KEY]
    .filter(Boolean)
    .map((k) => `Bearer ${k}`);
  if (allowed.length === 0 || !allowed.includes(auth)) {
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
    return json({ notified: [], skipped: [], reason: 'bot token not configured' });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available');
    return json({ notified: [], skipped: [], reason: 'supabase not configured' });
  }

  // Group line items by owning tenant. Items with no resolvable owner
  // (product deleted before checkout, or stale cache without owner info) are
  // logged and skipped — there is no group to route them to.
  const itemsByOwner = new Map<string, OrderItem[]>();
  for (const item of order.items ?? []) {
    const ownerId = itemOwnerId(item);
    if (!ownerId) {
      console.warn('order item without owner, skipping:', item.product?.id);
      continue;
    }
    const list = itemsByOwner.get(ownerId) ?? [];
    list.push(item);
    itemsByOwner.set(ownerId, list);
  }

  if (itemsByOwner.size === 0) {
    return json({ notified: [], skipped: [], reason: 'no tenant-owned items' });
  }

  // Resolve group chat ids + shop names. profiles is not anon-readable, so
  // this uses the service role (server-side only).
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ownerIds = [...itemsByOwner.keys()];
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, shop_name, telegram_chat_id')
    .in('id', ownerIds);

  if (profilesError) {
    console.error('failed to load tenant profiles:', profilesError);
    return json(
      { notified: [], skipped: [], reason: 'profile lookup failed' },
      500
    );
  }

  const notified: { shop: string; chat_id: string; warning?: string }[] = [];
  const skipped: { shop: string; reason: string }[] = [];

  for (const ownerId of ownerIds) {
    const items = itemsByOwner.get(ownerId) ?? [];
    const profile = (profiles ?? []).find((p) => p.id === ownerId);
    const shopName: string =
      profile?.shop_name ??
      itemShopName(items[0]) ??
      'Shop';
    const chatId: string | null = profile?.telegram_chat_id ?? null;

    if (!chatId) {
      console.warn(`tenant ${ownerId} (${shopName}) has no telegram_chat_id`);
      skipped.push({ shop: shopName, reason: 'no chat id configured' });
      continue;
    }

    let effectiveChatId = chatId;
    let result = await sendToTenant(supabase, { ownerId, shopName, chatId }, order, items);

    // When a Telegram group is upgraded to a supergroup, Telegram assigns it a
    // NEW chat id and rejects sends to the old one — but tells us the new id.
    // Adopt it (persisted on the tenant profile) and retry once, so a group
    // upgrade never silently breaks notifications again.
    if (!result.ok) {
      const migrated = result.error?.match(/migrate_to_chat_id":(-?\d+)/)?.[1];
      if (migrated && migrated !== chatId) {
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ telegram_chat_id: migrated })
          .eq('id', ownerId);
        if (updateError) {
          console.error(`failed to persist migrated chat id for ${ownerId}:`, updateError);
        } else {
          console.log(
            `tenant ${ownerId} (${shopName}) group became a supergroup; chat id updated to ${migrated}`
          );
          effectiveChatId = migrated;
          result = await sendToTenant(supabase, { ownerId, shopName, chatId: migrated }, order, items);
        }
      }
    }

    if (result.ok) {
      notified.push({
        shop: shopName,
        chat_id: effectiveChatId,
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } else {
      skipped.push({
        shop: shopName,
        reason: result.error ?? 'telegram send failed',
      });
    }
  }

  return json({ notified, skipped });
});
