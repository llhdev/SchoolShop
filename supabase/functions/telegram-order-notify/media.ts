// Pure media-classification helpers for telegram-order-notify.
// Kept free of Deno-only imports and with erasable TypeScript syntax only so
// the Node test script (scripts/test-telegram-media.mjs) can import this file
// directly and test the exact code the deployed function runs.

export type ProofKind = 'jpeg' | 'png' | 'heic' | 'other';

/** attach:// name for the payment proof when sent as uploaded bytes. */
export const PROOF_ATTACH_NAME = 'payment_proof.jpg';

/** Telegram photo ceiling (10 MB); documents may be much larger. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Sniff the actual image format from magic bytes — the stored .jpg name
 *  says nothing (pickers can return HEIC, which Telegram cannot process as
 *  a photo: IMAGE_PROCESS_FAILED). */
export function sniffProofKind(bytes: ArrayBuffer): ProofKind {
  const u = new Uint8Array(bytes.slice(0, 16));
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'jpeg';
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'png';
  // ISO BMFF container: bytes 4-8 are "ftyp", followed by the brand.
  if (u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) {
    const brand = String.fromCharCode(u[8], u[9], u[10], u[11]);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return 'heic';
    }
  }
  return 'other';
}

export function proofMime(kind: ProofKind): string {
  if (kind === 'jpeg') return 'image/jpeg';
  if (kind === 'png') return 'image/png';
  if (kind === 'heic') return 'image/heic';
  return 'application/octet-stream';
}

export type ProofDelivery =
  | { mode: 'photo'; attachName: string; kind: ProofKind }
  | { mode: 'document'; attachName: string; kind: ProofKind }
  | { mode: 'url-fallback' }
  | { mode: 'none' };

/** Decide how the payment proof reaches Telegram.
 *  The proof rides as an inline photo only when Telegram can process it as
 *  one: sniffed JPEG/PNG within the 10 MB photo ceiling. Anything else
 *  (HEIC from iPhone pickers, oversized, unknown) goes as a document — it
 *  used to poison the whole album (IMAGE_PROCESS_FAILED) and take the
 *  product images down with it. When the proof couldn't be downloaded at
 *  all, it falls back to riding as a URL (legacy behavior). */
export function decideProofDelivery(
  proofBytes: ArrayBuffer | null,
  proofUrl: string | null
): ProofDelivery {
  if (proofBytes === null) {
    return proofUrl ? { mode: 'url-fallback' } : { mode: 'none' };
  }
  const kind = sniffProofKind(proofBytes);
  const asPhoto = (kind === 'jpeg' || kind === 'png') && proofBytes.byteLength <= MAX_PHOTO_BYTES;
  if (asPhoto) {
    return { mode: 'photo', attachName: PROOF_ATTACH_NAME, kind };
  }
  return {
    mode: 'document',
    attachName: `payment-proof.${kind === 'jpeg' ? 'jpg' : kind === 'other' ? 'bin' : kind}`,
    kind,
  };
}
