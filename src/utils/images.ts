import { Platform } from 'react-native';
import { Product } from '../types';

/**
 * Returns the trimmed image URL, or null when there is none. Components render
 * a local colored placeholder (see ProductImage) instead of a remote
 * placehold.co URL, so the UI works offline.
 */
export function getProductImage(image?: string): string | null {
  if (image && image.trim().length > 0) {
    return image;
  }
  return null;
}

export function getProductCoverImage(product: Product): string | null {
  return getProductImage(product.images[product.coverImageIndex ?? 0]);
}

export function getProductGalleryImages(product: Product): (string | null)[] {
  if (product.images.length > 0) {
    return product.images.map((image) => getProductImage(image));
  }
  return [null];
}

const THUMB_MARKER = '-thumb';

/**
 * Derives the companion thumbnail URL for an uploaded image
 * (`name.jpg` -> `name-thumb.jpg`). Returns the URL unchanged when it does
 * not look like an uploaded JPEG; callers fall back to the full image when
 * the thumbnail 404s (products uploaded before thumbnails existed).
 */
export function getThumbnailUrl(url: string): string {
  if (!url.startsWith('http')) return url;
  const withoutQuery = url.split('?')[0];
  if (!withoutQuery.toLowerCase().endsWith('.jpg')) return url;
  return url.replace(/\.jpg(?=\?|$)/i, `${THUMB_MARKER}.jpg`);
}

export function getThumbnailPath(path: string): string {
  if (!path.toLowerCase().endsWith('.jpg')) return path;
  return path.replace(/\.jpg$/i, `${THUMB_MARKER}.jpg`);
}

export async function resizeImage(uri: string, maxWidth = 800): Promise<string> {
  // Web (browser + Telegram Mini App WebView): canvas-based resize. The
  // native-only expo module is dynamically imported so it stays out of the
  // web bundle.
  if (Platform.OS === 'web') {
    const { resizeImageWeb } = await import('../lib/image-web');
    return resizeImageWeb(uri, maxWidth);
  }
  try {
    const ImageManipulator = await import('expo-image-manipulator');
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: maxWidth } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
    );
    return manipulated.uri;
  } catch {
    return uri;
  }
}
