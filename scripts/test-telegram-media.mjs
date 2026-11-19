// Regression tests for the telegram-order-notify media-routing logic.
// Guards the Nov 2026 outage class: HEIC/oversized proofs poisoning the
// Telegram album (IMAGE_PROCESS_FAILED) so product photos and the payment
// proof never reached the shop groups.
//
// Imports the REAL helper module the deployed edge function uses
// (supabase/functions/telegram-order-notify/media.ts) — no copied logic.
// Requires Node >= 22.18 (native TypeScript type stripping).
//
// Run: node scripts/test-telegram-media.mjs

import assert from 'node:assert/strict';
import {
  decideProofDelivery,
  sniffProofKind,
  proofMime,
  MAX_PHOTO_BYTES,
  PROOF_ATTACH_NAME,
} from '../supabase/functions/telegram-order-notify/media.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

/** Build an ArrayBuffer of the given size whose first bytes are `header`. */
function buf(header, size = 64) {
  const u = new Uint8Array(size);
  u.set(header.slice(0, size));
  return u.buffer;
}

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]; // ..JFIF
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a

/** ISO BMFF container (HEIC/HEIF) with the given brand, e.g. 'heic'. */
function heicBuf(brand) {
  const header = [
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70, // "ftyp"
    ...brand.split('').map((c) => c.charCodeAt(0)),
  ];
  return buf(header);
}

console.log('sniffProofKind — format detection from magic bytes');

test('detects JPEG', () => {
  assert.equal(sniffProofKind(buf(JPEG_HEADER)), 'jpeg');
});

test('detects PNG', () => {
  assert.equal(sniffProofKind(buf(PNG_HEADER)), 'png');
});

for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']) {
  test(`detects HEIC family brand "${brand}"`, () => {
    assert.equal(sniffProofKind(heicBuf(brand)), 'heic');
  });
}

test('GIF is not a photo kind Telegram accepts → other', () => {
  assert.equal(sniffProofKind(buf(GIF_HEADER)), 'other');
});

test('empty buffer → other', () => {
  assert.equal(sniffProofKind(new ArrayBuffer(0)), 'other');
});

test('buffer shorter than 16 bytes → still detected from available bytes', () => {
  assert.equal(sniffProofKind(buf(JPEG_HEADER, 3)), 'jpeg');
});

console.log('proofMime — MIME per kind');

test('jpeg/png/heic/other MIME mapping', () => {
  assert.equal(proofMime('jpeg'), 'image/jpeg');
  assert.equal(proofMime('png'), 'image/png');
  assert.equal(proofMime('heic'), 'image/heic');
  assert.equal(proofMime('other'), 'application/octet-stream');
});

console.log('decideProofDelivery — the routing that broke in production');

test('JPEG proof ≤ 10 MB rides as an inline photo', () => {
  const d = decideProofDelivery(buf(JPEG_HEADER), 'https://example.test/proof.jpg');
  assert.equal(d.mode, 'photo');
  assert.equal(d.attachName, PROOF_ATTACH_NAME);
  assert.equal(d.kind, 'jpeg');
});

test('PNG proof ≤ 10 MB rides as an inline photo', () => {
  const d = decideProofDelivery(buf(PNG_HEADER), 'https://example.test/proof.png');
  assert.equal(d.mode, 'photo');
  assert.equal(d.kind, 'png');
});

test('proof exactly at the 10 MB ceiling is still a photo', () => {
  const d = decideProofDelivery(buf(JPEG_HEADER, MAX_PHOTO_BYTES), 'https://example.test/p.jpg');
  assert.equal(d.mode, 'photo');
});

test('JPEG proof over 10 MB goes as a document (would fail as a photo)', () => {
  const d = decideProofDelivery(buf(JPEG_HEADER, MAX_PHOTO_BYTES + 1), 'https://example.test/p.jpg');
  assert.equal(d.mode, 'document');
  assert.equal(d.attachName, 'payment-proof.jpg');
  assert.equal(d.kind, 'jpeg');
});

test('HEIC proof goes as a document — never poisons the album', () => {
  const d = decideProofDelivery(heicBuf('heic'), 'https://example.test/proof.jpg');
  assert.equal(d.mode, 'document');
  assert.equal(d.attachName, 'payment-proof.heic');
  assert.equal(d.kind, 'heic');
});

test('unknown/GIF proof goes as a document with .bin name', () => {
  const d = decideProofDelivery(buf(GIF_HEADER), 'https://example.test/proof.jpg');
  assert.equal(d.mode, 'document');
  assert.equal(d.attachName, 'payment-proof.bin');
  assert.equal(d.kind, 'other');
});

test('undownloadable proof with a URL falls back to riding as a URL', () => {
  const d = decideProofDelivery(null, 'https://example.test/proof.jpg');
  assert.equal(d.mode, 'url-fallback');
});

test('no proof at all → none', () => {
  const d = decideProofDelivery(null, null);
  assert.equal(d.mode, 'none');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
