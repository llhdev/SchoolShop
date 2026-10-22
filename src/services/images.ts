import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { resizeImage, getThumbnailPath } from '../utils/images';

/** Public base URL of the Cloudflare R2 bucket that now serves all display
 *  images (product photos + thumbnails, shop logos, bank QRs) and digital-book
 *  PDFs (books/ prefix, migration 044). Public info, safe to inline. Keys are
 *  namespaced: products/, logos/, qrs/, books/. */
export const R2_PUBLIC_BASE_URL = 'https://img.timor.et';

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.includes(',') ? base64.split(',')[1] : base64;
  const binary = (globalThis as unknown as { atob: (data: string) => string }).atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function fileUriToArrayBuffer(uri: string): Promise<ArrayBuffer> {
  // Dynamic import keeps the native-only file-system module out of the
  // web/TMA bundle (web uploads always arrive as data URIs, see below).
  const FileSystem = await import('expo-file-system/legacy');
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToArrayBuffer(base64);
}

function isDataUri(value: string): boolean {
  return value.startsWith('data:');
}

/** Reads a picked file into bytes: data URIs (web pickers) are decoded
 *  directly, native file URIs go through expo-file-system. */
export async function imageToArrayBuffer(uri: string): Promise<ArrayBuffer> {
  if (isDataUri(uri)) {
    return base64ToArrayBuffer(uri);
  }
  return fileUriToArrayBuffer(uri);
}

// --- Cloudflare R2 uploads (presigned by the r2-upload-sign edge function) -----

interface SignedUpload {
  key: string;
  uploadUrl: string;
  publicUrl: string;
}

/** Ask the edge function to presign PUT URLs for the given R2 keys. Requires
 *  a signed-in admin session — the function checks the caller's role. */
export async function signR2Uploads(keys: string[]): Promise<SignedUpload[]> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!supabaseUrl || !anonKey || !token) {
    throw new Error('Sign in as an admin to upload images.');
  }
  const response = await fetch(`${supabaseUrl}/functions/v1/r2-upload-sign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'sign', files: keys.map((key) => ({ key })) }),
  });
  const body = (await response.json().catch(() => null)) as
    | { uploads?: SignedUpload[]; error?: string }
    | null;
  if (!response.ok || !body?.uploads) {
    throw new Error(body?.error ?? `Could not prepare the upload (HTTP ${response.status}).`);
  }
  return body.uploads;
}

/** PUT raw bytes to a presigned R2 URL. Display images are immutable
 *  (unique filenames) and cached for a year; proofs are private and never
 *  cached. */
export async function putToR2(
  uploadUrl: string,
  buffer: ArrayBuffer,
  cacheControl = 'public, max-age=31536000, immutable',
  contentType = 'image/jpeg'
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    },
    body: buffer,
  });
  if (!response.ok) {
    throw new Error(`Upload failed (HTTP ${response.status}).`);
  }
}

/** Delete R2 objects by key (full + thumb). Best-effort — callers chain
 *  .catch(() => {}) already. */
export async function deleteR2Objects(keys: string[]): Promise<void> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!supabaseUrl || !anonKey || !token) return;
  const response = await fetch(`${supabaseUrl}/functions/v1/r2-upload-sign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'delete', keys }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `R2 delete failed (HTTP ${response.status}).`);
  }
}

function newFileName(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.jpg`;
}

/** Upload one image to R2 under the given prefix and return its public URL. */
async function uploadR2Image(uri: string, prefix: 'products' | 'logos' | 'qrs'): Promise<string> {
  const key = `${prefix}/${newFileName()}`;
  const buffer = await imageToArrayBuffer(uri);
  const [upload] = await signR2Uploads([key]);
  await putToR2(upload.uploadUrl, buffer);
  return upload.publicUrl;
}

export async function uploadProductImage(uri: string): Promise<string> {
  const baseName = newFileName();
  const key = `products/${baseName}`;
  const thumbKey = `products/${getThumbnailPath(baseName)}`;

  // Upload the full image and a 400px thumbnail companion so list views can
  // fetch small payloads on slow connections. The product record stores the
  // full URL only; thumbnails are derived by naming convention.
  const [fullBuffer, thumbUri] = await Promise.all([imageToArrayBuffer(uri), resizeImage(uri, 400)]);
  const thumbBuffer = await imageToArrayBuffer(thumbUri);
  const [full, thumb] = await signR2Uploads([key, thumbKey]);

  await putToR2(full.uploadUrl, fullBuffer);
  // A missing thumbnail only hurts bandwidth, not correctness.
  try {
    await putToR2(thumb.uploadUrl, thumbBuffer);
  } catch (error) {
    console.warn('Thumbnail upload failed:', error);
  }

  return full.publicUrl;
}

export async function uploadProductImages(uris: string[]): Promise<string[]> {
  return Promise.all(uris.map((uri) => uploadProductImage(uri)));
}

/** Shopper's payment proof photo for one tenant, uploaded at checkout.
 *  Goes to the PRIVATE R2 proofs bucket via the r2-upload-sign edge
 *  function's anonymous sign-proof-upload action (shoppers aren't signed
 *  in) and returns the bare object key — not a URL. Older orders hold the
 *  same key format in the legacy Supabase bucket; readers fall back
 *  automatically. */
export async function uploadPaymentProof(uri: string): Promise<string> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error('Image storage is not configured.');
  const key = newFileName();
  const buffer = await imageToArrayBuffer(uri);
  const response = await fetch(`${supabaseUrl}/functions/v1/r2-upload-sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ action: 'sign-proof-upload', files: [{ key }] }),
  });
  const body = (await response.json().catch(() => null)) as
    | { uploads?: { key: string; uploadUrl: string }[]; error?: string }
    | null;
  const upload = body?.uploads?.[0];
  if (!response.ok || !upload) {
    throw new Error(body?.error ?? `Could not prepare the upload (HTTP ${response.status}).`);
  }
  await putToR2(upload.uploadUrl, buffer, 'private, no-cache');
  return upload.key;
}

/** Resolve proof object keys to viewable URLs for admins (OrderDetail).
 *  The edge function presigns R2 GETs and falls back to Supabase signed
 *  URLs for not-yet-migrated proofs. Requires a signed-in admin session.
 *  Legacy full-URL refs pass through unchanged. */
export async function getPaymentProofUrls(refs: string[]): Promise<(string | null)[]> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!supabaseUrl || !anonKey || !token) return refs.map(() => null);
  const keys = refs.filter((ref) => !isRemoteImage(ref));
  const response = await fetch(`${supabaseUrl}/functions/v1/r2-upload-sign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'sign-proof-get', keys }),
  });
  const body = (await response.json().catch(() => null)) as
    | { proofs?: { key: string; url: string | null }[]; error?: string }
    | null;
  const byKey = new Map((body?.proofs ?? []).map((p) => [p.key, p.url]));
  return refs.map((ref) => (isRemoteImage(ref) ? ref : byKey.get(ref) ?? null));
}

/** Tenant's bank transfer QR code, uploaded by the super admin or the tenant.
 *  Uploaded as-is (no resize — QRs must stay scannable). */
export async function uploadBankQr(uri: string): Promise<string> {
  return uploadR2Image(uri, 'qrs');
}

/** Tenant shop logo, uploaded by the super admin (migration 023). Logos are
 *  display-only and rendered small (store filter chips/lists), so they are
 *  resized to 400px before upload — unlike QR codes, no scannability concern. */
export async function uploadShopLogo(uri: string): Promise<string> {
  const resized = await resizeImage(uri, 400);
  return uploadR2Image(resized, 'logos');
}

export async function deleteProductImage(url: string): Promise<void> {
  if (!url) return;

  // R2 URLs: strip the public base URL to get the object key, delete the
  // full image and its thumbnail companion via the edge function.
  const r2Marker = `${R2_PUBLIC_BASE_URL}/`;
  if (url.startsWith(r2Marker)) {
    const key = url.slice(r2Marker.length);
    await deleteR2Objects([key, getThumbnailPath(key)]);
    return;
  }

  // Legacy Supabase URLs (products uploaded before the R2 move).
  const marker = '/object/public/product-images/';
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) return;

  const path = url.slice(markerIndex + marker.length);
  const { error } = await supabase.storage
    .from('product-images')
    .remove([path, getThumbnailPath(path)]);
  if (error) throw error;
}

export async function deleteProductImages(urls: string[]): Promise<void> {
  await Promise.all(urls.map((url) => deleteProductImage(url)));
}

export function isRemoteImage(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export function isLocalImage(uri: string): boolean {
  return Platform.OS === 'web'
    ? isDataUri(uri)
    : !isRemoteImage(uri);
}
