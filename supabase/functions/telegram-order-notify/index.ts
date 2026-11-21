// Routes a newly placed order to each tenant's Telegram group: every shop that
// owns at least one ordered item gets a summary + cover images of THEIR items
// plus THEIR payment proof photo (orders.payment_proofs, migration 020)
// (order id, customer phone/location are shared — it's one delivery).
// Tenants without a configured group chat id are skipped and reported.
// Called by the client right after a successful order insert (fire-and-forget)
// — the bot token stays server-side.
//
// SECURITY: the HTTP body is trusted ONLY as a carrier for the order id
// (`id`, or `order_id`). The full order is re-read from the orders table
// with the service role before anything is sent — the row is trustworthy
// (stamp_order_tenants stamps item owner_id/shop_name and forces status
// server-side, migration 054; created_at is forced by 041) — so a forged
// payload cannot inject fake order messages: an id matching no order gets
// a 404, and an id matching a real order sends exactly what the row says.
// This makes the public-key auth gate below harmless: anyone holding the
// shipped anon/publishable key can only trigger a re-send of a real order's
// own summary.
//
// Payment-verification state rides INLINE in the per-shop summary: a warning
// line when checkout could not confirm the payment (payment_warnings, 056), a
// verified line when a reference was already confirmed (payment_references,
// 041). The caption-bearing message id + text are persisted to
// orders.telegram_notifications (057) so a verification completing AFTER the
// message was sent can edit the same message in place — never a second one.
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
import {
  PROOF_ATTACH_NAME,
  decideProofDelivery,
  proofMime,
  type ProofKind,
} from './media.ts';

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
  /** Branch chosen at checkout, re-stamped server-side (migration 045). */
  branchName?: string;
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
  /** Verified payment references, keyed by tenant owner id (migration 041;
   *  warning passes also stamp one, 056). Renders the ✅ line inline. */
  payment_references?: Record<string, { provider: string; reference: string; key: string }>;
  /** Unconfirmed-payment warnings, keyed by tenant owner id (migration 056).
   *  Renders the ⚠️ line inline; takes precedence over the ✅ line. */
  payment_warnings?: Record<string, { reason: string; detail?: string }>;
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

/** A product image whose object is missing from R2 (404) makes Telegram
 *  reject the WHOLE album — including the payment proof riding in it. HEAD
 *  the public URL first and skip dead ones so one bad image only costs its
 *  own photo. Network errors keep the URL: they say nothing about the
 *  object, and the text-summary fallback below still covers a real failure.
 *  Only used for public product URLs — never presigned proof URLs, whose
 *  signature is method-bound (HEAD would 403 a perfectly good GET URL). */
async function isReachablePublicUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return true;
  }
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
  ownerId: string,
  shopName: string,
  items: OrderItem[],
  shippingFee: number
): string {
  const lines: string[] = [];
  lines.push('<b>🛒 New Order</b>');
  lines.push(`🏪 ${escapeHtml(shopName)}`);
  const branchName = items.find((item) => item.branchName)?.branchName;
  if (branchName) lines.push(`🏬 Branch: ${escapeHtml(branchName)}`);
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
  // Payment-verification state rides inline, per shop (056/057): the warning
  // line wins when checkout could not confirm the payment; a verified
  // reference without a warning shows the ✅ line. The ⚠️ text must stay
  // exactly this — verifyWorkflow matches it when editing the message after
  // a late verification completes.
  if (order.payment_warnings?.[ownerId]) {
    lines.push('⚠️ Payment unconfirmed — check proof');
  } else if (order.payment_references?.[ownerId]) {
    lines.push('✅ Payment Verified');
  }
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
  /** Telegram's parsed `result` payload on success (a Message object, or an
   *  array of Messages for sendMediaGroup) — lets the send ladder capture the
   *  caption-bearing message id instead of discarding the success body. */
  result?: unknown;
  /** Message id of the message carrying the order summary (caption or text),
   *  persisted to orders.telegram_notifications for in-place edits (057). */
  captionMessageId?: number;
  /** Chat the summary was delivered to (post-supergroup-migration). */
  chatId?: number;
  /** Which send path delivered the summary — picks editMessageCaption vs
   *  editMessageText later. */
  captionKind?: 'photo' | 'album' | 'document' | 'text';
  /** Exact caption/message text sent — stored so the late-verification edit
   *  can reconstruct the new text (the Bot API cannot read a caption back). */
  captionText?: string;
}

/** Extract message id + chat id from a Telegram `result` payload: a Message
 *  for single-message sends, an array of Messages for sendMediaGroup (the
 *  caption rides on the first item). */
function messageMeta(result: unknown): { messageId?: number; chatId?: number } {
  const message = Array.isArray(result) ? result[0] : result;
  if (message && typeof message === 'object') {
    const m = message as { message_id?: unknown; chat?: { id?: unknown } };
    return {
      messageId: typeof m.message_id === 'number' ? m.message_id : undefined,
      chatId: typeof m.chat?.id === 'number' ? m.chat.id : undefined,
    };
  }
  return {};
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
    // Keep the parsed result payload (Message / Message[]) — the caller
    // captures the caption-bearing message id from it.
    const body = await res.json().catch(() => null);
    const result =
      body && typeof body === 'object' ? (body as { result?: unknown }).result : undefined;
    return { ok: true, result };
  } catch (error) {
    console.error(`telegram ${method} error:`, error);
    return { ok: false, error: `${method} threw: ${String(error)}` };
  }
}

/** Multipart variant for sending files as uploaded bytes (attach://)
 *  instead of URLs Telegram must fetch. Telegram's fetcher intermittently
 *  fails on presigned R2 URLs (WEBPAGE_CURL_FAILED), which used to reject
 *  the whole album — uploading the bytes removes that dependency entirely.
 *  The file field name must match the attach:// name used in the payload. */
async function sendTelegramMultipart(
  method: string,
  fields: Record<string, string>,
  attachName: string,
  attachBytes: ArrayBuffer,
  attachMime: string
): Promise<SendResult> {
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append(attachName, new Blob([attachBytes], { type: attachMime }), attachName);
    const res = await fetch(`${API}/${method}`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text();
      console.error(`telegram ${method} (multipart) failed:`, res.status, body);
      return { ok: false, error: `${method} ${res.status}: ${body.slice(0, 300)}` };
    }
    const body = await res.json().catch(() => null);
    const result =
      body && typeof body === 'object' ? (body as { result?: unknown }).result : undefined;
    return { ok: true, result };
  } catch (error) {
    console.error(`telegram ${method} (multipart) error:`, error);
    return { ok: false, error: `${method} threw: ${String(error)}` };
  }
}

interface MediaItem {
  type: 'photo';
  media: string;
  caption?: string;
  parse_mode?: 'HTML';
}

interface ProofAttach {
  name: string;
  bytes: ArrayBuffer;
  kind: ProofKind;
}

/** One photo message. Attach variant is used when the item references the
 *  proof's attach:// name. */
async function sendPhotoItem(
  chatId: string,
  item: MediaItem,
  attach: ProofAttach | null
): Promise<SendResult> {
  const fields: Record<string, string> = {
    chat_id: chatId,
    photo: item.media,
    ...(item.caption ? { caption: item.caption, parse_mode: 'HTML' } : {}),
  };
  if (attach && item.media.startsWith('attach://')) {
    return sendTelegramMultipart('sendPhoto', fields, attach.name, attach.bytes, proofMime(attach.kind));
  }
  return sendTelegram('sendPhoto', fields);
}

/** Photo album (2-10 items). When the proof rides as an attached photo the
 *  whole request goes multipart; otherwise plain JSON. */
async function sendAlbumItems(
  chatId: string,
  items: MediaItem[],
  attach: ProofAttach | null
): Promise<SendResult> {
  if (attach) {
    return sendTelegramMultipart(
      'sendMediaGroup',
      { chat_id: chatId, media: JSON.stringify(items) },
      attach.name,
      attach.bytes,
      proofMime(attach.kind)
    );
  }
  return sendTelegram('sendMediaGroup', { chat_id: chatId, media: items });
}

/** Proof as a downloadable document — the fallback for bytes Telegram
 *  cannot process as a photo (HEIC, oversized, corrupt). The shop still
 *  receives the evidence, just not as an inline photo. */
async function sendProofDocument(
  chatId: string,
  attach: ProofAttach,
  caption?: string
): Promise<SendResult> {
  return sendTelegramMultipart(
    'sendDocument',
    {
      chat_id: chatId,
      document: `attach://${attach.name}`,
      ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    },
    attach.name,
    attach.bytes,
    proofMime(attach.kind)
  );
}

async function sendToTenant(
  supabase: SupabaseClient,
  target: TenantTarget,
  order: OrderPayload,
  items: OrderItem[]
): Promise<SendResult> {
  const shippingFee = order.shipping_fees?.[target.ownerId] ?? 0;
  const summary = buildSummary(order, target.ownerId, target.shopName, items, shippingFee);

  // Cover image of each line item, deduped. One album slot is reserved for
  // the payment proof below, so the cap is applied to item photos only.
  const urls: string[] = [];
  for (const item of items) {
    const url = itemCoverUrl(item);
    if (url && !urls.includes(url) && (await isReachablePublicUrl(url))) {
      urls.push(url);
    }
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

  const media: MediaItem[] = photos.map((url, index) => ({
    type: 'photo',
    media: url,
    ...(index === 0 ? { caption: summary, parse_mode: 'HTML' as const } : {}),
  }));

  // The proof rides as an inline photo only when Telegram can process it as
  // one: sniffed JPEG/PNG within the 10 MB photo ceiling. Anything else
  // (HEIC from iPhone pickers, oversized, unknown) is delivered as a
  // document below — it used to poison the whole album
  // (IMAGE_PROCESS_FAILED) and take the product images down with it.
  // The decision lives in decideProofDelivery (media.ts) so the Node test
  // script exercises the exact deployed logic.
  const delivery = decideProofDelivery(proofBytes, proofUrl);
  const proofAsPhoto = delivery.mode === 'photo';
  let proofAsDocument = delivery.mode === 'document';
  const proofAttach: ProofAttach | null =
    proofBytes !== null && (delivery.mode === 'photo' || delivery.mode === 'document')
      ? { name: delivery.attachName, bytes: proofBytes, kind: delivery.kind }
      : null;

  if (proofAsPhoto && proofAttach) {
    media.push({
      type: 'photo',
      media: `attach://${PROOF_ATTACH_NAME}`,
      ...(media.length === 0 ? { caption: summary, parse_mode: 'HTML' as const } : {}),
    });
  } else if (!proofBytes && proofUrl) {
    // Download failed — legacy behavior: the proof rides as a URL and takes
    // its chances with Telegram's fetcher.
    media.push({
      type: 'photo',
      media: proofUrl,
      ...(media.length === 0 ? { caption: summary, parse_mode: 'HTML' as const } : {}),
    });
  }

  const errors: string[] = [];
  let summaryDelivered = false;
  // Locator for the caption-bearing message, persisted to
  // orders.telegram_notifications so a late payment verification can edit
  // THIS message in place (057).
  let captionMessageId: number | undefined;
  let captionChatId: number | undefined;
  let captionKind: 'photo' | 'album' | 'document' | 'text' | undefined;

  const fallbackChatId = (): number | undefined => {
    const parsed = Number(target.chatId);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const captureCaption = (
    sent: SendResult,
    kind: 'photo' | 'album' | 'document' | 'text'
  ): void => {
    const meta = messageMeta(sent.result);
    captionMessageId = meta.messageId;
    captionChatId = meta.chatId ?? fallbackChatId();
    captionKind = kind;
  };

  // 1) Photo message: a lone photo goes through sendPhoto (albums require
  //    2-10 items), otherwise a media-group album.
  if (media.length === 1) {
    const single = await sendPhotoItem(target.chatId, media[0], proofAsPhoto ? proofAttach : null);
    if (single.ok) {
      summaryDelivered = true;
      captureCaption(single, 'photo');
    } else {
      errors.push(single.error ?? 'sendPhoto failed');
    }
  } else if (media.length > 1) {
    let album = await sendAlbumItems(target.chatId, media, proofAsPhoto ? proofAttach : null);
    let albumKind: 'album' | 'photo' = 'album';
    if (!album.ok && proofAsPhoto && (album.error ?? '').includes('IMAGE_PROCESS_FAILED')) {
      // The sniffed JPEG/PNG still failed to process (corrupt/odd encoding)
      // and poisoned the album — retry photos only, proof becomes a document.
      errors.push(album.error ?? 'sendMediaGroup failed');
      proofAsDocument = true;
      const photosOnly = media.filter((m) => !m.media.startsWith('attach://'));
      albumKind = photosOnly.length === 1 ? 'photo' : 'album';
      album =
        photosOnly.length === 1
          ? await sendPhotoItem(target.chatId, photosOnly[0], null)
          : await sendAlbumItems(target.chatId, photosOnly, null);
    }
    if (album.ok) {
      summaryDelivered = true;
      captureCaption(album, albumKind);
    } else {
      errors.push(album.error ?? 'sendMediaGroup failed');
    }
  }

  // 2) Proof as a downloadable document when it couldn't ride as a photo.
  if (proofAsDocument && proofAttach) {
    const summaryAlreadySent = summaryDelivered;
    const doc = await sendProofDocument(
      target.chatId,
      proofAttach,
      summaryAlreadySent ? '🧾 Payment proof' : summary
    );
    if (doc.ok) {
      summaryDelivered = true;
      // Only capture when the document carries the SUMMARY caption; the
      // '🧾 Payment proof' companion caption is not the order message.
      if (!summaryAlreadySent) captureCaption(doc, 'document');
    } else {
      errors.push(doc.error ?? 'sendDocument failed');
    }
  }

  // 3) Last resort: plain text so the order is never lost. Any failure above
  //    is reported as a warning — the delivery is degraded, not lost, and
  //    hiding it is how the Nov 2026 outage went unnoticed.
  if (!summaryDelivered) {
    const text = await sendTelegram('sendMessage', {
      chat_id: target.chatId,
      text: summary,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (text.ok) {
      summaryDelivered = true;
      captureCaption(text, 'text');
    } else {
      errors.push(text.error ?? 'sendMessage failed');
    }
  }

  if (summaryDelivered) {
    const delivered: SendResult =
      errors.length > 0
        ? { ok: true, warning: `degraded delivery (${errors.join(' | ')})` }
        : { ok: true };
    if (captionMessageId !== undefined && captionKind !== undefined) {
      delivered.captionMessageId = captionMessageId;
      delivered.captionKind = captionKind;
      delivered.captionText = summary;
      if (captionChatId !== undefined) delivered.chatId = captionChatId;
    }
    return delivered;
  }
  return { ok: false, error: errors.join(' | ') };
}

// --- rate limiting ------------------------------------------------------------

/** Fixed-window rate limit via the service-role check_rate_limit RPC (061).
 *  The IP (first x-forwarded-for entry) is SHA-256 hashed so no raw addresses
 *  are stored; non-IP keys (per-order) pass through unchanged. FAILS OPEN on
 *  error — availability over strictness — and logs the failure. */
async function withinRateLimit(
  supabase: SupabaseClient,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    return data === true;
  } catch (error) {
    console.error(`rate limit check failed (${key.split(':')[0]}), allowing request:`, error);
    return true;
  }
}

async function hashedIpKey(req: Request, scope: string): Promise<string> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${scope}:${hash}`;
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
  // builds keep working. Both keys ship in the web bundle, so this is NOT
  // the security boundary — that is the DB re-read below: only the order id
  // is taken from the request and everything else comes from the orders row.
  const auth = req.headers.get('authorization') ?? '';
  const allowed = [ANON_KEY, PUBLISHABLE_KEY]
    .filter(Boolean)
    .map((k) => `Bearer ${k}`);
  if (allowed.length === 0 || !allowed.includes(auth)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // The body is trusted ONLY as a carrier for the order id: `id` (current
  // clients) or `order_id` (future). Every other field is ignored — the
  // order is re-read from the DB below.
  let orderId: unknown;
  try {
    const body = (await req.json()) as { id?: unknown; order_id?: unknown } | null;
    orderId = typeof body?.id === 'string' ? body.id : body?.order_id;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof orderId !== 'string' || orderId.length === 0) {
    return json({ error: 'order id required' }, 400);
  }

  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN secret is not set');
    return json({ notified: [], skipped: [], reason: 'bot token not configured' });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available');
    return json({ notified: [], skipped: [], reason: 'supabase not configured' });
  }

  // Service role: reads orders, profiles.telegram_chat_id and shoppers
  // (profiles is not anon-readable), and persists telegram_notifications.
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The bearer gate above uses a key that ships in the public bundle, so it
  // is not the security boundary — these limits are what stop a copied key
  // from spamming re-sends or amplifying fetches: at most 10 sends per order
  // per hour and 300 notify calls per IP per hour. (The ops resend scripts
  // send each order once; batches over 300/hr just get 429s and can rerun.)
  if (!(await withinRateLimit(supabase, await hashedIpKey(req, 'notify-ip'), 300, 3600))) {
    return json({ error: 'too many requests, try again later' }, 429);
  }
  if (!(await withinRateLimit(supabase, `notify-order:${orderId}`, 10, 3600))) {
    return json({ error: 'too many notifications for this order, try again later' }, 429);
  }

  // Re-read the order row — this is the ONLY source of truth for what gets
  // sent. A payload id that matches no row is rejected, which kills forged
  // "New Order" injection entirely.
  const { data: row, error: orderError } = await supabase
    .from('orders')
    .select(
      'id, items, total, payment_method, status, location, phone_number, telegram_id, created_at, payment_proofs, shipping_fees, payment_references, payment_warnings'
    )
    .eq('id', orderId)
    .maybeSingle();
  if (orderError) {
    console.error('failed to load order:', orderError);
    return json({ notified: [], skipped: [], reason: 'order lookup failed' }, 500);
  }
  if (!row) {
    return json({ notified: [], skipped: [], reason: 'unknown order' }, 404);
  }

  const order: OrderPayload = {
    id: row.id ?? undefined,
    items: row.items ?? undefined,
    total: row.total ?? undefined,
    payment_method: row.payment_method ?? undefined,
    status: row.status ?? undefined,
    location: row.location ?? undefined,
    phone_number: row.phone_number ?? undefined,
    telegram_id: row.telegram_id ?? undefined,
    created_at: row.created_at ?? undefined,
    payment_proofs: row.payment_proofs ?? undefined,
    shipping_fees: row.shipping_fees ?? undefined,
    payment_references: row.payment_references ?? undefined,
    payment_warnings: row.payment_warnings ?? undefined,
  };

  // The orders row has no shopper name/username — buildSummary's
  // "✈️ Telegram user" line needs it, so look the shopper up in the public
  // shoppers table (telegram_id PK) when the order carries a telegram_id.
  if (order.telegram_id) {
    const { data: shopper, error: shopperError } = await supabase
      .from('shoppers')
      .select('first_name, last_name, username')
      .eq('telegram_id', order.telegram_id)
      .maybeSingle();
    if (shopperError) {
      console.error('failed to load shopper:', shopperError);
    } else if (shopper) {
      order.telegram_user = {
        first_name: shopper.first_name ?? undefined,
        last_name: shopper.last_name ?? undefined,
        username: shopper.username ?? undefined,
      };
    }
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

  // Resolve group chat ids + shop names via the service-role client created
  // above (profiles is not anon-readable).
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

      // Persist the caption-bearing message locator so a payment verification
      // completing AFTER this message was sent can edit it in place (057).
      // Read-modify-write is safe here: one order is processed by a single
      // invocation. Failures are logged, never fail the response — the admin
      // UI badge still carries the verification state.
      if (
        order.id &&
        result.captionMessageId !== undefined &&
        result.captionKind !== undefined &&
        result.chatId !== undefined
      ) {
        try {
          const entry = {
            chat_id: result.chatId,
            message_id: result.captionMessageId,
            kind: result.captionKind,
            text: result.captionText ?? '',
          };
          const { data: row, error: readError } = await supabase
            .from('orders')
            .select('telegram_notifications')
            .eq('id', order.id)
            .single();
          if (readError) throw readError;
          const existing =
            row?.telegram_notifications &&
            typeof row.telegram_notifications === 'object' &&
            !Array.isArray(row.telegram_notifications)
              ? (row.telegram_notifications as Record<string, unknown>)
              : {};
          const { error: updateError } = await supabase
            .from('orders')
            .update({ telegram_notifications: { ...existing, [ownerId]: entry } })
            .eq('id', order.id);
          if (updateError) throw updateError;
        } catch (error) {
          console.error(
            `failed to persist telegram notification for order ${order.id} tenant ${ownerId}:`,
            error
          );
        }
      }
    } else {
      skipped.push({
        shop: shopName,
        reason: result.error ?? 'telegram send failed',
      });
    }
  }

  return json({ notified, skipped });
});
