// Presigned uploads + deletes for Cloudflare R2.
//
// Display images (products/photos, logos, QRs) live in the PUBLIC bucket
// served from https://img.timor.et — admins request presigned PUT URLs and
// upload bytes straight to R2, then store the public URL.
//
// Payment proofs live in the PRIVATE R2_PROOFS_BUCKET (no public access):
//   - sign-proof-upload: anonymous (shoppers aren't signed in), presigned
//     PUT, flat <name>.jpg keys only, max 4 per request.
//   - sign-proof-get:    presigned GET for the super admin or an active shop
//     account with the financial or branch capability. Falls back to a
//     Supabase signed URL for proofs not yet migrated off
//     payment-proofs-private.
//
// Digital-book PDFs (migration 044) live in the PUBLIC bucket under books/:
// admins upload/delete them via the normal sign/delete actions; the anonymous
// sign-book-get action reveals a paid post's file URLs only when the caller's
// order item has reached 'paid' AND the caller knows the order's phone number
// (062 — the order id alone is no longer enough, order ids are short codes).
//
// Key namespacing (061): new display/PDF keys are tenant-namespaced —
// products|logos|qrs/<tenantId>/<name>.jpg and books/<tenantId>/<name>.pdf,
// where <tenantId> is the uploader's effective tenant id (uuid). sign accepts
// ONLY namespaced keys, and the key's tenant segment must equal the caller's
// effective tenant id (super admin may sign any tenant's keys — it manages
// shops and uploads their logos/QRs). delete accepts namespaced keys under
// the same rule, plus LEGACY un-namespaced keys (pre-061 objects) only after
// verifying ownership server-side: a legacy products//books/ key must be
// referenced by the caller's own products (images/detail_images, or
// product_files for books), and a legacy logos//qrs/ key by the caller's own
// profiles row (shop_logo_url / bank_accounts QR urls). This stops any staff
// account from overwriting or deleting another shop's objects, whose keys
// are discoverable because the bucket is public.
//
// Rate limiting (061): the anonymous sign-proof-upload action is capped at
// 20 requests per IP per hour (public.check_rate_limit, SHA-256-hashed IP).
// The check fails OPEN — if the rate-limit RPC errors the request is allowed
// (availability over strictness for this endpoint) and the error is logged.
//
// verify_jwt is off at the gateway (the app calls this with the user's own
// access token, and OPTIONS must be answered for browsers), so the function
// authenticates the caller itself for the admin actions: bearer token ->
// auth.getUser -> profiles. Capability rules (staff roles, migration 045+):
//   - sign/delete:    super_admin passes; an active (is_active) shop account
//     needs staff_shop for products/ and books/ keys, and must be the shop
//     owner (no parent_tenant_id) for logos/ and qrs/ keys — plus the tenant
//     namespacing rule above.
//   - sign-proof-get: super_admin, or an active shop account with
//     staff_financial or staff_branch.
//
// Required secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET, R2_PUBLIC_BASE_URL, R2_PROOFS_BUCKET. SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { R2_BUCKET, R2_PROOFS_BUCKET, presign, r2Configured, signedRequest } from '../_shared/r2Sign.ts';

const R2_PUBLIC_BASE_URL = (Deno.env.get('R2_PUBLIC_BASE_URL') ?? '').replace(/\/+$/, '');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const PRESIGN_EXPIRY_SECONDS = 600;
// Book PDFs are large and upload slowly — their presigned PUTs live longer.
const BOOK_PRESIGN_EXPIRY_SECONDS = 3600;
const MAX_FILES_PER_REQUEST = 20;
const MAX_PROOF_UPLOADS_PER_REQUEST = 4;

// New keys are tenant-namespaced (061): products|logos|qrs/<tenantId>/<name>.jpg
// and books/<tenantId>/<name>.pdf, where <tenantId> is the uploader's
// effective tenant id (uuid) and <name> keeps the client-generated
// `${Date.now()}-<random>[-thumb]` charset. Namespacing stops cross-tenant
// overwrite/delete — the bucket is public, so bare keys are discoverable.
const TENANT_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_PATTERN = new RegExp(
  `^(?:(?:products|logos|qrs)/${TENANT_SEGMENT}/[a-z0-9][a-z0-9-]*\\.jpg|books/${TENANT_SEGMENT}/[a-z0-9][a-z0-9-]*\\.pdf)$`
);
// Pre-061 objects use un-namespaced keys. They can never be created anymore;
// deletes of them are allowed only after server-side ownership verification
// (see ownsLegacyKey).
const LEGACY_KEY_PATTERN = /^(?:(?:products|logos|qrs)\/[a-z0-9][a-z0-9-]*\.jpg|books\/[a-z0-9][a-z0-9-]*\.pdf)$/;
// Proof keys are the same flat `${Date.now()}-<random>.jpg` names the client
// has always used (keys did not change with the R2 move).
const PROOF_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*\.jpg$/;

/** The tenant segment of a namespaced key, null for legacy keys. */
function keyTenantId(key: string): string | null {
  if (!KEY_PATTERN.test(key)) return null;
  return key.split('/')[1];
}

// Supabase bucket that held proofs before the R2 move (transition fallback).
const LEGACY_PROOFS_BUCKET = 'payment-proofs-private';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// --- auth ----------------------------------------------------------------------

interface AdminProfile {
  id: string;
  role: string;
  parent_tenant_id: string | null;
  staff_financial: boolean | null;
  staff_shop: boolean | null;
  staff_branch: boolean | null;
  is_active: boolean | null;
}

/** Returns the caller's profile when they are a signed-in admin, else the
 *  error response. */
async function requireAdmin(
  req: Request
): Promise<{ profile: AdminProfile } | { error: Response }> {
  const token = (req.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'sign in required' }, 401) };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { error: json({ error: 'invalid session' }, 401) };
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, parent_tenant_id, staff_financial, staff_shop, staff_branch, is_active')
    .eq('id', data.user.id)
    .maybeSingle();
  if (profile?.role !== 'admin' && profile?.role !== 'super_admin') {
    return { error: json({ error: 'admins only' }, 403) };
  }
  return { profile: profile as AdminProfile };
}

/** The tenant the caller acts for: the parent shop for staff accounts, the
 *  account itself for owners and the super admin (same rule as the
 *  effective_tenant_id() SQL helper, migration 045). */
function effectiveTenantId(profile: AdminProfile): string {
  return profile.parent_tenant_id ?? profile.id;
}

/** Upload gate per key (staff roles + tenant namespacing, 061): the super
 *  admin passes; an active shop account may only sign keys namespaced under
 *  its own effective tenant id, needs the shop capability for products/ and
 *  books/ keys, and must be the shop owner for logos/ and qrs/ (shop
 *  settings). */
function canWriteKey(profile: AdminProfile, key: string): boolean {
  if (profile.role === 'super_admin') return true;
  if (profile.is_active === false) return false;
  if (keyTenantId(key) !== effectiveTenantId(profile)) return false;
  if (key.startsWith('products/') || key.startsWith('books/')) {
    return profile.staff_shop === true;
  }
  return profile.parent_tenant_id === null;
}

/** Ownership of a legacy (un-namespaced) products//books/ key: a product of
 *  the caller's shop references it in images/detail_images — as the full
 *  public URL or the bare key — or, for books/, one of the shop's
 *  product_files rows holds it. Thumbnail keys (`-thumb.jpg`) are checked
 *  against their base image, which is the reference products actually store. */
async function ownsLegacyShopKey(tenantId: string, key: string): Promise<boolean> {
  if (key.startsWith('books/')) {
    const { data, error } = await supabase
      .from('product_files')
      .select('id, products!inner(owner_id)')
      .eq('key', key)
      .eq('products.owner_id', tenantId)
      .limit(1);
    if (error) console.error('legacy book ownership check failed:', error.message ?? error);
    return (data?.length ?? 0) > 0;
  }
  const baseKey = key.replace(/-thumb\.jpg$/, '.jpg');
  const candidates = [baseKey, `${R2_PUBLIC_BASE_URL}/${baseKey}`];
  const or = candidates
    .flatMap((c) => [`images.cs.{${c}}`, `detail_images.cs.{${c}}`])
    .join(',');
  const { data, error } = await supabase
    .from('products')
    .select('id')
    .eq('owner_id', tenantId)
    .or(or)
    .limit(1);
  if (error) console.error('legacy image ownership check failed:', error.message ?? error);
  return (data?.length ?? 0) > 0;
}

/** Ownership of a legacy (un-namespaced) logos//qrs/ key: the caller's own
 *  (effective tenant's) profiles row references it in shop_logo_url or one of
 *  its bank_accounts QR urls. */
async function ownsLegacyProfileKey(tenantId: string, key: string): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('profiles')
    .select('shop_logo_url, bank_accounts')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) console.error('legacy profile ownership check failed:', error.message ?? error);
  if (!row) return false;
  const matches = (value: unknown): boolean =>
    typeof value === 'string' &&
    (value === key || value === `${R2_PUBLIC_BASE_URL}/${key}`);
  if (matches(row.shop_logo_url)) return true;
  const accounts = Array.isArray(row.bank_accounts) ? row.bank_accounts : [];
  return accounts.some((a) => matches((a as { qr_image_url?: unknown })?.qr_image_url));
}

/** Delete gate: namespaced keys follow the same rule as uploads; legacy
 *  un-namespaced keys are deletable only after the server verifies the
 *  caller's shop actually references them (the key charset is guessable and
 *  the bucket public, so capability alone proved nothing about ownership). */
async function canDeleteKey(profile: AdminProfile, key: string): Promise<boolean> {
  if (keyTenantId(key) !== null) return canWriteKey(profile, key);
  if (!LEGACY_KEY_PATTERN.test(key)) return false;
  // The super admin manages all shops' products — no ownership proof needed.
  if (profile.role === 'super_admin') return true;
  const tenantId = effectiveTenantId(profile);
  if (key.startsWith('products/') || key.startsWith('books/')) {
    if (profile.role !== 'super_admin') {
      if (profile.is_active === false || profile.staff_shop !== true) return false;
    }
    return ownsLegacyShopKey(tenantId, key);
  }
  // logos/qrs are shop settings — owner-only (staff have parent_tenant_id).
  if (profile.role !== 'super_admin') {
    if (profile.is_active === false || profile.parent_tenant_id !== null) return false;
  }
  return ownsLegacyProfileKey(tenantId, key);
}

/** Proof viewing gate: the super admin, or an active shop account with the
 *  financial or branch capability. */
function canReadProofs(profile: AdminProfile): boolean {
  if (profile.role === 'super_admin') return true;
  return (
    profile.is_active !== false &&
    (profile.staff_financial === true || profile.staff_branch === true)
  );
}

// --- actions ---------------------------------------------------------------------

async function handleSignUploads(
  body: Record<string, unknown>,
  profile: AdminProfile
): Promise<Response> {
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0 || files.length > MAX_FILES_PER_REQUEST) {
    return json({ error: `files must contain 1-${MAX_FILES_PER_REQUEST} entries` }, 400);
  }
  const keys: string[] = [];
  for (const f of files) {
    const key = typeof f === 'object' && f !== null ? (f as Record<string, unknown>).key : null;
    if (typeof key !== 'string' || keyTenantId(key) === null) {
      return json({ error: 'each file needs a valid tenant-namespaced key (products|logos|qrs|books)/<tenantId>/<name>' }, 400);
    }
    if (!canWriteKey(profile, key)) {
      return json({ error: 'not allowed for your role' }, 403);
    }
    keys.push(key);
  }
  const uploads = await Promise.all(
    keys.map(async (key) => ({
      key,
      // Book PDFs can be tens of MB — on a slow connection 10 minutes is not
      // enough to finish the PUT, so they get an hour.
      uploadUrl: await presign(
        'PUT',
        R2_BUCKET,
        key,
        key.startsWith('books/') ? BOOK_PRESIGN_EXPIRY_SECONDS : PRESIGN_EXPIRY_SECONDS
      ),
      publicUrl: `${R2_PUBLIC_BASE_URL}/${key}`,
    }))
  );
  return json({ uploads });
}

async function handleDeletes(
  body: Record<string, unknown>,
  profile: AdminProfile
): Promise<Response> {
  const keysRaw = Array.isArray(body.keys) ? body.keys : [];
  if (keysRaw.length === 0 || keysRaw.length > 50) {
    return json({ error: 'keys must contain 1-50 entries' }, 400);
  }
  const keys: string[] = [];
  for (const k of keysRaw) {
    if (typeof k !== 'string' || (keyTenantId(k) === null && !LEGACY_KEY_PATTERN.test(k))) {
      return json({ error: 'invalid key' }, 400);
    }
    if (!(await canDeleteKey(profile, k))) {
      return json({ error: 'not allowed for your role' }, 403);
    }
    keys.push(k);
  }
  const results = await Promise.all(
    keys.map(async (key) => {
      const res = await signedRequest('DELETE', R2_BUCKET, key);
      // S3 returns 204 on success and on already-missing keys; both are fine.
      return res.ok || res.status === 204;
    })
  );
  const failed = keys.filter((_, i) => !results[i]);
  if (failed.length > 0) console.error('R2 deletes failed:', failed);
  return json({ deleted: keys.length - failed.length, failed });
}

// --- per-IP rate limiting (061) ------------------------------------------------

/** Fixed-window per-IP rate limit via the service-role check_rate_limit RPC
 *  (public.rate_limits). The IP (first x-forwarded-for entry) is SHA-256
 *  hashed so no raw addresses are stored. FAILS OPEN: if the RPC errors the
 *  request is allowed — availability over strictness for these endpoints —
 *  and the failure is logged. Returns false only when the window is full. */
async function withinRateLimit(
  req: Request,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  try {
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_key: `${scope}:${hash}`,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    return data === true;
  } catch (error) {
    console.error(`rate limit check failed (${scope}), allowing request:`, error);
    return true;
  }
}

/** Anonymous shopper proof uploads. No auth — same exposure as the public-
 *  insert Supabase bucket this replaces, but tighter: pattern-restricted
 *  keys, at most 4 per request, 20 presign requests per IP per hour (061),
 *  URLs expire in 10 minutes, and the bucket is private so junk uploads are
 *  invisible to everyone. */
async function handleSignProofUpload(req: Request, body: Record<string, unknown>): Promise<Response> {
  if (!(await withinRateLimit(req, 'proof-upload', 20, 3600))) {
    return json({ error: 'too many uploads, try again later' }, 429);
  }
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0 || files.length > MAX_PROOF_UPLOADS_PER_REQUEST) {
    return json({ error: `files must contain 1-${MAX_PROOF_UPLOADS_PER_REQUEST} entries` }, 400);
  }
  const keys: string[] = [];
  for (const f of files) {
    const key = typeof f === 'object' && f !== null ? (f as Record<string, unknown>).key : null;
    if (typeof key !== 'string' || !PROOF_KEY_PATTERN.test(key)) {
      return json({ error: 'each file needs a valid flat <name>.jpg key' }, 400);
    }
    keys.push(key);
  }
  const uploads = await Promise.all(
    keys.map(async (key) => ({
      key,
      uploadUrl: await presign('PUT', R2_PROOFS_BUCKET, key, PRESIGN_EXPIRY_SECONDS),
    }))
  );
  return json({ uploads });
}

/** Admin-only proof viewing. Presigns R2 GETs; proofs not yet migrated to R2
 *  fall back to a Supabase signed URL from the legacy bucket. Returns one
 *  entry per requested key (null when the proof exists in neither place). */
async function handleSignProofGet(
  body: Record<string, unknown>,
  profile: AdminProfile
): Promise<Response> {
  if (!canReadProofs(profile)) {
    return json({ error: 'not allowed for your role' }, 403);
  }
  const keysRaw = Array.isArray(body.keys) ? body.keys : [];
  if (keysRaw.length === 0 || keysRaw.length > MAX_FILES_PER_REQUEST) {
    return json({ error: `keys must contain 1-${MAX_FILES_PER_REQUEST} entries` }, 400);
  }
  const keys: string[] = [];
  for (const k of keysRaw) {
    if (typeof k !== 'string' || !PROOF_KEY_PATTERN.test(k)) {
      return json({ error: 'invalid key' }, 400);
    }
    keys.push(k);
  }
  const proofs = await Promise.all(
    keys.map(async (key) => {
      const head = await signedRequest('HEAD', R2_PROOFS_BUCKET, key);
      if (head.ok) {
        return { key, url: await presign('GET', R2_PROOFS_BUCKET, key, PRESIGN_EXPIRY_SECONDS) };
      }
      const { data, error } = await supabase.storage
        .from(LEGACY_PROOFS_BUCKET)
        .createSignedUrl(key, 3600);
      if (error) console.error('legacy proof sign failed:', key, error.message ?? error);
      return { key, url: data?.signedUrl ?? null };
    })
  );
  return json({ proofs });
}

/** Statuses that unlock paid digital downloads: the merchant has confirmed
 *  the item (lifecycle order pending -> paid -> on_the_way -> completed). */
const DOWNLOAD_UNLOCKED_STATUSES = new Set(['paid', 'on_the_way', 'completed']);

/** Anonymous shopper download gate for paid digital files (migration 044).
 *  The books live in the PUBLIC bucket, so protection comes from never
 *  exposing paid keys to anon clients (product_files RLS only exposes files
 *  of price-0 products) and revealing them here only after the buyer's order
 *  item reached 'paid'. Since 062 the caller must also present the order's
 *  phone number (trimmed compare) — order id + product id alone no longer
 *  unlock anything. Returns public URLs — no presigning needed. */
async function handleSignBookGet(body: Record<string, unknown>): Promise<Response> {
  const orderId = typeof body.orderId === 'string' ? body.orderId : '';
  const productId = typeof body.productId === 'string' ? body.productId : '';
  const phone = typeof body.phone === 'string' ? body.phone : '';
  if (!orderId || !productId || !phone.trim()) {
    return json({ error: 'orderId, productId and phone are required' }, 400);
  }

  const { data: order } = await supabase
    .from('orders')
    .select('items, status, item_statuses, phone_number')
    .eq('id', orderId)
    .maybeSingle();
  // One generic refusal for unknown orders AND phone mismatches — the
  // response must not confirm an order id exists.
  if (!order || !order.phone_number || order.phone_number !== phone.trim()) {
    return json({ error: 'not unlocked' }, 403);
  }

  interface OrderItemSnapshot {
    product?: { id?: string };
    selectedImageIndex?: number;
    selectedOptions?: { group: string; option: string }[];
  }
  const items = Array.isArray(order.items) ? (order.items as OrderItemSnapshot[]) : [];
  const item = items.find((it) => it?.product?.id === productId);
  if (!item) return json({ error: 'not unlocked' }, 403);

  // Same line-key rule as the client's getCartItemLineId (utils/variants.ts).
  const variantKey = (item.selectedOptions ?? [])
    .map((o) => `${o.group}=${o.option}`)
    .join('|');
  const lineKey = `${productId}:${item.selectedImageIndex ?? 0}${variantKey ? `:${variantKey}` : ''}`;
  const itemStatuses = (order.item_statuses ?? {}) as Record<string, string>;
  const status = itemStatuses[lineKey] ?? (order.status as string);
  if (!DOWNLOAD_UNLOCKED_STATUSES.has(status)) return json({ error: 'not unlocked' }, 403);

  const { data: files, error } = await supabase
    .from('product_files')
    .select('name, key, size_bytes')
    .eq('product_id', productId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('product_files lookup failed:', error.message ?? error);
    return json({ error: 'could not load files' }, 500);
  }
  return json({
    files: (files ?? []).map((f) => ({
      name: f.name as string,
      url: `${R2_PUBLIC_BASE_URL}/${f.key}`,
      sizeBytes: (f.size_bytes as number | null) ?? null,
    })),
  });
}

// --- entry point -----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!r2Configured() || !R2_PUBLIC_BASE_URL) {
    console.error('R2 secrets are not configured');
    return json({ error: 'image storage not configured' }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const action = typeof body.action === 'string' ? body.action : '';

  // Shopper proof uploads and paid-book downloads are the anonymous actions.
  let profile: AdminProfile | null = null;
  if (action !== 'sign-proof-upload' && action !== 'sign-book-get') {
    const auth = await requireAdmin(req);
    if ('error' in auth) return auth.error;
    profile = auth.profile;
  }

  switch (action) {
    case 'sign':
      return handleSignUploads(body, profile!);
    case 'delete':
      return handleDeletes(body, profile!);
    case 'sign-proof-upload':
      return handleSignProofUpload(req, body);
    case 'sign-proof-get':
      return handleSignProofGet(body, profile!);
    case 'sign-book-get':
      return handleSignBookGet(body);
    default:
      return json({ error: 'unknown action' }, 400);
  }
});
