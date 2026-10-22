import { supabase } from '../lib/supabase';
import { ProductFile } from '../types';
import {
  R2_PUBLIC_BASE_URL,
  deleteR2Objects,
  imageToArrayBuffer,
  putToR2,
  signR2Uploads,
} from './images';

/** PDFs up to this size can be attached to a post (client-side guard; R2
 *  presigned PUTs cannot enforce a size limit server-side). */
export const MAX_PDF_BYTES = 60 * 1024 * 1024;

interface DbProductFile {
  id: string;
  product_id: string;
  name: string;
  key: string;
  size_bytes: number | null;
}

function toProductFile(db: DbProductFile): ProductFile {
  return {
    id: db.id,
    productId: db.product_id,
    name: db.name,
    key: db.key,
    url: `${R2_PUBLIC_BASE_URL}/${db.key}`,
    sizeBytes: db.size_bytes ?? undefined,
  };
}

/** Files attached to a product. Anonymous callers only see files of free
 *  (price-0) posts — RLS hides paid posts' files; signed-in tenant admins see
 *  all files of their own products. */
export async function fetchProductFiles(productId: string): Promise<ProductFile[]> {
  const { data, error } = await supabase
    .from('product_files')
    .select('*')
    .eq('product_id', productId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toProductFile);
}

export interface PdfUploadSource {
  /** Display name for the download button. */
  name: string;
  /** Web/TMA: file bytes straight from the picker. */
  buffer?: ArrayBuffer;
  /** Native: file URI from expo-document-picker. */
  uri?: string;
  /** Known size (native picker reports it); derived from the buffer on web. */
  sizeBytes?: number;
}

/** Upload one PDF to the public R2 bucket under books/ and return its
 *  metadata. Requires a signed-in admin session (the sign action checks). */
export async function uploadProductPdf(
  source: PdfUploadSource
): Promise<{ key: string; url: string; sizeBytes: number }> {
  const buffer = source.buffer ?? (source.uri ? await imageToArrayBuffer(source.uri) : null);
  if (!buffer) throw new Error('No PDF data to upload.');
  const sizeBytes = source.sizeBytes ?? buffer.byteLength;
  if (sizeBytes > MAX_PDF_BYTES) {
    throw new Error('PDF is too large — keep it under 60 MB.');
  }
  const key = `books/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.pdf`;
  const [upload] = await signR2Uploads([key]);
  await putToR2(upload.uploadUrl, buffer, 'public, max-age=31536000, immutable', 'application/pdf');
  return { key: upload.key, url: upload.publicUrl, sizeBytes };
}

/** Register an uploaded PDF on a product post. */
export async function addProductFile(
  productId: string,
  file: { name: string; key: string; sizeBytes?: number }
): Promise<ProductFile> {
  const { data, error } = await supabase
    .from('product_files')
    .insert({
      product_id: productId,
      name: file.name,
      key: file.key,
      size_bytes: file.sizeBytes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return toProductFile(data as DbProductFile);
}

/** Remove a file from a post; the R2 object is deleted best-effort. */
export async function deleteProductFile(id: string, key: string): Promise<void> {
  const { error } = await supabase.from('product_files').delete().eq('id', id);
  if (error) throw error;
  await deleteR2Objects([key]).catch(() => {});
}

export interface PurchasedBookFile {
  name: string;
  url: string;
  sizeBytes?: number;
}

/** Paid-book downloads for a shopper: the edge function returns the files
 *  only when the order item has reached 'paid'. Returns [] while locked. */
export async function getPurchasedBookFiles(
  orderId: string,
  productId: string
): Promise<PurchasedBookFile[]> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return [];
  const response = await fetch(`${supabaseUrl}/functions/v1/r2-upload-sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ action: 'sign-book-get', orderId, productId }),
  });
  const body = (await response.json().catch(() => null)) as
    | { files?: { name: string; url: string; sizeBytes?: number | null }[] }
    | null;
  if (!response.ok || !body?.files) return [];
  return body.files.map((f) => ({
    name: f.name,
    url: f.url,
    sizeBytes: f.sizeBytes ?? undefined,
  }));
}
