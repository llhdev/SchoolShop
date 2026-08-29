import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../lib/supabase';

const BUCKET = 'product-images';

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
  const buffer = await imageToArrayBuffer(uri);
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.jpg`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, buffer, {
      contentType: 'image/jpeg',
      upsert: false,
    });

  if (error) throw error;

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return publicUrlData.publicUrl;
}

export async function uploadProductImages(uris: string[]): Promise<string[]> {
  return Promise.all(uris.map((uri) => uploadProductImage(uri)));
}

export async function deleteProductImage(url: string): Promise<void> {
  if (!url) return;

  // Only delete URLs that belong to our Supabase storage bucket.
  const marker = `/object/public/${BUCKET}/`;
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) return;

  const path = url.slice(markerIndex + marker.length);
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
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
