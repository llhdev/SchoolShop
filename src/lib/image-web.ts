/**
 * Web-only image picking and resizing for admin product uploads in the
 * browser and the Telegram Mini App WebView, where expo-image-picker and
 * expo-image-manipulator do not run. Native builds never call these — the
 * pickers there stay on the expo modules.
 */

function readFileAsDataUri(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Opens the browser file picker and resolves with the chosen images as
 * base64 data URIs (empty array when cancelled). A hidden <input type=file>
 * works in browsers and inside the Telegram WebView.
 */
export function pickImagesWeb(): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;

    let settled = false;
    const finish = (uris: string[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      resolve(uris);
    };

    // Fallback for browsers without the `cancel` event: when the picker
    // closes without a selection the window regains focus.
    const onWindowFocus = () => {
      setTimeout(() => finish([]), 400);
    };

    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        finish([]);
        return;
      }
      const uris = await Promise.all(files.map(readFileAsDataUri));
      finish(uris.filter((uri): uri is string => uri !== null));
    });
    input.addEventListener('cancel', () => finish([]));

    window.addEventListener('focus', onWindowFocus);
    input.click();
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

/**
 * Resizes an image (data URI or blob URL) to a max width via canvas,
 * returning a JPEG data URI at 0.8 quality — the web equivalent of the
 * native expo-image-manipulator pipeline.
 */
export async function resizeImageWeb(
  uri: string,
  maxWidth = 800
): Promise<string> {
  try {
    const image = await loadImage(uri);
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return uri;

    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return uri;
  }
}
