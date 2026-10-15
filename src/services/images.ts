import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { resizeImage, getThumbnailPath } from '../utils/images';

const BUCKET = 'product-images';
const PAYMENT_PROOFS_PRIVATE_BUCKET = 'payment-proofs-private';
const BANK_QRS_BUCKET = 'bank-qrs';
const SHOP_LOGOS_BUCKET = 'shop-logos';

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

async function imageToArrayBuffer(uri: string): Promise<ArrayBuffer> {
  if (isDataUri(uri)) {
    return base64ToArrayBuffer(uri);
  }
  return fileUriToArrayBuffer(uri);
}

export async function uploadProductImage(uri: string): Promise<string> {
  const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const fileName = `${baseName}.jpg`;
  const thumbName = getThumbnailPath(fileName);

  // Upload the full image and a 400px thumbnail companion so list views can
  // fetch small payloads on slow connections. The product record stores the
  // full URL only; thumbnails are derived by naming convention.
  const [upload, thumbUpload] = await Promise.all([
    imageToArrayBuffer(uri).then((buffer) =>
      supabase.storage.from(BUCKET).upload(fileName, buffer, {
        contentType: 'image/jpeg',
        // Filenames are unique per upload, so content is immutable — let
        // browsers/WebViews cache aggressively for a year.
        cacheControl: '31536000',
        upsert: false,
      })
    ),
    resizeImage(uri, 400)
      .then((thumbUri) => imageToArrayBuffer(thumbUri))
      .then((buffer) =>
        supabase.storage.from(BUCKET).upload(thumbName, buffer, {
          contentType: 'image/jpeg',
          cacheControl: '31536000',
          upsert: false,
        })
      ),
  ]);

  if (upload.error) throw upload.error;
  // A missing thumbnail only hurts bandwidth, not correctness.
  if (thumbUpload.error) {
    console.warn('Thumbnail upload failed:', thumbUpload.error.message);
  }

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(upload.data.path);
  return publicUrlData.publicUrl;
}

export async function uploadProductImages(uris: string[]): Promise<string[]> {
  return Promise.all(uris.map((uri) => uploadProductImage(uri)));
}

/** Upload a single image to a bucket as-is (no thumbnail companion) and
 *  return its public URL. Used for payment proofs and tenant bank QR codes,
 *  which are viewed at full resolution by admins and the Telegram bot. */
export async function uploadSingleImage(uri: string, bucket: string): Promise<string> {
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.jpg`;
  const buffer = await imageToArrayBuffer(uri);
  const { data, error } = await supabase.storage.from(bucket).upload(fileName, buffer, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw error;
  const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(data.path);
  return publicUrlData.publicUrl;
}

/** Shopper's payment proof photo for one tenant, uploaded at checkout.
 *  Goes to the PRIVATE bucket (migration 040) and returns the storage object
 *  path — not a URL. Server-side readers (edge functions) download it with
 *  the service role; admins view it through short-lived signed URLs. Legacy
 *  orders hold full public payment-proofs URLs instead. */
export async function uploadPaymentProof(uri: string): Promise<string> {
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.jpg`;
  const buffer = await imageToArrayBuffer(uri);
  const { data, error } = await supabase.storage
    .from(PAYMENT_PROOFS_PRIVATE_BUCKET)
    .upload(fileName, buffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw error;
  return data.path;
}

/** Tenant's bank transfer QR code, uploaded by the super admin or the tenant. */
export async function uploadBankQr(uri: string): Promise<string> {
  return uploadSingleImage(uri, BANK_QRS_BUCKET);
}

/** Tenant shop logo, uploaded by the super admin (migration 023). Logos are
 *  display-only and rendered small (store filter chips/lists), so they are
 *  resized to 400px before upload — unlike QR codes, no scannability concern. */
export async function uploadShopLogo(uri: string): Promise<string> {
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.jpg`;
  const resized = await resizeImage(uri, 400);
  const buffer = await imageToArrayBuffer(resized);
  const { data, error } = await supabase.storage.from(SHOP_LOGOS_BUCKET).upload(fileName, buffer, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw error;
  const { data: publicUrlData } = supabase.storage.from(SHOP_LOGOS_BUCKET).getPublicUrl(data.path);
  return publicUrlData.publicUrl;
}

export async function deleteProductImage(url: string): Promise<void> {
  if (!url) return;

  // Only delete URLs that belong to our Supabase storage bucket.
  const marker = `/object/public/${BUCKET}/`;
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) return;

  const path = url.slice(markerIndex + marker.length);
  const { error } = await supabase.storage
    .from(BUCKET)
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
