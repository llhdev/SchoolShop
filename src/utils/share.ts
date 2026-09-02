import { Platform, Share } from 'react-native';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { CartItem } from '../types';

export function formatOrderMessage(
  cart: CartItem[],
  cartTotal: number
): string {
  const items = cart
    .map(
      (item) =>
        `${item.quantity} × ${item.product.name} — $${(
          item.product.price * item.quantity
        ).toFixed(2)}`
    )
    .join('\n');

  return `Hello, I would like to order:\n\n${items}\n\nTotal: $${cartTotal.toFixed(2)}`;
}

async function downloadImage(uri: string): Promise<string | null> {
  // Already a local file — use as-is.
  if (uri.startsWith('file://') || uri.startsWith('content://')) {
    return uri;
  }

  // Base64 data URIs are not supported by react-native-share's urls array,
  // so skip them.
  if (uri.startsWith('data:')) {
    return null;
  }

  try {
    const extension = uri.split('.').pop()?.split('?')[0] || 'jpg';
    const filename = `shared-image-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.${extension}`;
    const file = await ExpoFile.downloadFileAsync(
      uri,
      new ExpoFile(Paths.cache, filename)
    );
    return file.uri;
  } catch {
    return null;
  }
}

async function shareWithNativeModule(
  cart: CartItem[],
  cartTotal: number,
  summaryImageUri?: string
): Promise<boolean> {
  try {
    const RNShare = (await import('react-native-share')).default;

    const imageUris = cart.map(
      (item) => item.product.images[item.selectedImageIndex ?? 0]
    );

    const localUris = (
      await Promise.all(
        imageUris.map((uri) => (uri ? downloadImage(uri) : null))
      )
    ).filter((uri): uri is string => uri !== null);

    // Put the summary image first so it is easy to spot in Telegram.
    const urls = summaryImageUri
      ? [summaryImageUri, ...localUris]
      : localUris;

    if (urls.length === 0) {
      return false;
    }

    await RNShare.open({
      urls,
      failOnCancel: false,
    });

    return true;
  } catch {
    return false;
  }
}

async function shareWithBuiltIn(
  cart: CartItem[],
  cartTotal: number
): Promise<boolean> {
  const message = formatOrderMessage(cart, cartTotal);
  try {
    const result = await Share.share({ message });
    return result.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}

// --- Web image sharing helpers ---------------------------------------------

function dataUriToFile(dataUri: string, filename: string): File | null {
  const match = dataUri.match(/^data:(.+);base64,(.*)$/);
  if (!match) return null;

  const mime = match[1];
  const base64 = match[2];

  try {
    const byteString = atob(base64);
    const arrayBuffer = new ArrayBuffer(byteString.length);
    const uintArray = new Uint8Array(arrayBuffer);
    for (let i = 0; i < byteString.length; i++) {
      uintArray[i] = byteString.charCodeAt(i);
    }
    return new File([arrayBuffer], filename, { type: mime });
  } catch {
    return null;
  }
}

async function urlToFile(url: string, filename: string): Promise<File | null> {
  if (url.startsWith('data:')) {
    return dataUriToFile(url, filename);
  }

  try {
    const response = await Promise.race([
      fetch(url, { mode: 'cors' }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Image fetch timed out')), 4000)
      ),
    ]);
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], filename, { type: blob.type || 'image/jpeg' });
  } catch {
    return null;
  }
}

async function shareWithWebFiles(
  cart: CartItem[],
  cartTotal: number,
  summaryImageUri?: string
): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.share) {
    return false;
  }

  const files: File[] = [];

  if (summaryImageUri) {
    const summaryFile = dataUriToFile(
      summaryImageUri,
      `order-summary-${Date.now()}.png`
    );
    if (summaryFile) files.push(summaryFile);
  }

  const productFiles = await Promise.all(
    cart.map(async (item, index) => {
      const uri = item.product.images[item.selectedImageIndex ?? 0];
      if (!uri) return null;
      const extension = uri.split('.').pop()?.split('?')[0] || 'jpg';
      const filename = `product-${index + 1}-${item.product.id}.${extension}`;
      return urlToFile(uri, filename);
    })
  );

  for (const file of productFiles) {
    if (file) files.push(file);
  }

  if (files.length === 0) return false;

  const canShareFiles = navigator.canShare && navigator.canShare({ files });
  if (!canShareFiles) return false;

  try {
    await navigator.share({
      files,
      title: 'Order from Timor Shop',
    });
    return true;
  } catch (error) {
    // User canceled the share sheet — treat it as shared to match native behavior.
    if (error instanceof Error && error.name === 'AbortError') {
      return true;
    }
    return false;
  }
}

export async function shareOrder(
  cart: CartItem[],
  cartTotal: number,
  summaryImageUri?: string
) {
  // Web: share image files via the Web Share API when supported.
  if (Platform.OS === 'web') {
    const shared = await shareWithWebFiles(cart, cartTotal, summaryImageUri);
    if (shared) return true;

    return shareWithBuiltIn(cart, cartTotal);
  }

  // Native: try react-native-share first for image attachments.
  const shared = await shareWithNativeModule(cart, cartTotal, summaryImageUri);
  if (shared) return true;

  // Fallback for Expo Go or if react-native-share is unavailable.
  return shareWithBuiltIn(cart, cartTotal);
}
