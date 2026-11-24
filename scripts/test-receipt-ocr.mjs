// Regression test for the receipt extractor (src/lib/ocr.ts) against the
// fixture corpus in scripts/receipt-fixtures/. Each fixture is a redacted
// real-world payment screenshot; manifest.json (generated from the original
// NOTES.txt ground truth, QR-decoded values treated as authoritative) says
// which provider + reference each must yield. Entries may list
// altReferences — alternative identifiers for the same transaction. For
// telebirr those are OCR-ambiguity variants, equally valid. For CBE the
// altReference is the modern mbreciept Receipt ID, which verify.et does NOT
// resolve (prod: 4/4 not_found — only the legacy FT reference works), so a
// Receipt ID is accepted only as a last resort and every acceptance is
// flagged with a WARN line: the fixture's FT should have been extracted.
//
// Run: node scripts/test-receipt-ocr.mjs [--ocr-cache]
//   --ocr-cache  reuse full-page OCR results from .tmp-audit/test-ocr-cache
//                (fast re-runs while tuning the parser; delete the cache to
//                force fresh OCR). Refinement crops are cheap, never cached.
//
// The test drives the real pipeline — extractReceiptReferenceFromPixels with
// a Node tesseract worker — so what passes here is what the app ships.
// tesseract's language data is read from .tmp-audit/lang/eng.traineddata.gz
// (created from the repo's eng.traineddata) so no network is needed.

import { createWorker, OEM } from 'tesseract.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import ts from 'typescript';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'scripts', 'receipt-fixtures');
const OCR_CACHE = path.join(ROOT, '.tmp-audit', 'test-ocr-cache');
const useOcrCache = process.argv.includes('--ocr-cache');

// Compile src/lib/ocr.ts (self-contained TS) to ESM so the code under test
// is exactly what the app ships.
const ocrSource = readFileSync(path.join(ROOT, 'src', 'lib', 'ocr.ts'), 'utf8');
const compiled = ts.transpileModule(ocrSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
mkdirSync(path.join(ROOT, '.tmp-audit'), { recursive: true });
const compiledPath = path.join(ROOT, '.tmp-audit', 'ocr.compiled.mjs');
writeFileSync(compiledPath, compiled);
const ocr = await import(pathToFileURL(compiledPath).href);

const manifest = JSON.parse(readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));

if (useOcrCache) mkdirSync(OCR_CACHE, { recursive: true });

const worker = await createWorker('eng', OEM.LSTM_ONLY, {
  langPath: path.join(ROOT, '.tmp-audit', 'lang'),
  cacheMethod: 'none',
  gzip: true,
});

const encodeImage = (px) => {
  const png = new PNG({ width: px.width, height: px.height });
  png.data = Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength);
  return PNG.sync.write(png);
};

let pass = 0;
let fail = 0;
const failures = [];
const warnings = [];

for (const entry of manifest) {
  const file = path.join(FIXTURES, entry.file);
  const raw = jpeg.decode(readFileSync(file), { maxMemoryUsageInMB: 512 });
  const pixels = {
    data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
    width: raw.width,
    height: raw.height,
  };

  // Cache the expensive full-page recognize per fixture (keyed by path);
  // QR + refinement passes run fresh every time.
  const cacheKey = path.join(OCR_CACHE, entry.file.replace(/[\\/]/g, '__') + '.json');
  const cached = useOcrCache && existsSync(cacheKey) ? JSON.parse(readFileSync(cacheKey, 'utf8')) : null;
  const workerLike = {
    setParameters: (params) => worker.setParameters(params),
    async recognize(image, options, output) {
      if (output?.blocks && cached) return { data: cached };
      const res = await worker.recognize(image, options, output);
      if (output?.blocks && useOcrCache && !cached) writeFileSync(cacheKey, JSON.stringify(res.data));
      return res;
    },
  };

  const result = await ocr.extractReceiptReferenceFromPixels(pixels, undefined, {
    jsQR,
    createWorker: () => Promise.resolve(workerLike),
    encodeImage,
  });

  const accepted = [entry.reference, ...(entry.altReferences ?? [])].map((r) => r.toUpperCase());
  const primary = entry.reference.toUpperCase();
  const alts = (entry.altReferences ?? []).map((r) => r.toUpperCase());
  const got = (result.reference ?? '').toUpperCase();
  const okProvider = result.provider === entry.provider;
  let okReference = false;
  let warn = null;
  if (got === primary) {
    okReference = true;
  } else if (alts.includes(got) && entry.provider !== 'cbe') {
    okReference = true; // telebirr alts are OCR-ambiguity variants, equally valid
  } else if (alts.includes(got)) {
    // CBE: a Receipt ID is the last-resort fallback (verify.et doesn't
    // resolve it). Accept, but flag it — the fixture's FT should normally
    // have won, so this pinpoints fixtures whose FT isn't readable.
    okReference = true;
    warn = `returned Receipt ID ${result.reference} — FT ${entry.reference} was not extracted`;
  }
  const ok = okProvider && okReference && result.receiptLike;
  if (ok) {
    pass++;
    console.log(`ok   ${entry.file}  -> ${result.provider}:${result.reference}`);
    if (warn) {
      warnings.push(`${entry.file}: ${warn}`);
      console.log(`WARN ${entry.file}  ${warn}`);
    }
  } else {
    fail++;
    failures.push(entry.file);
    console.log(
      `FAIL ${entry.file}  expected ${entry.provider}:${accepted.join('|')} ` +
        `got ${result.provider ?? '?'}:${result.reference ?? '?'} receiptLike=${result.receiptLike}`
    );
  }
}

await worker.terminate();
console.log(`\n${pass}/${manifest.length} passed`);
if (warnings.length > 0) {
  console.log(`\n${warnings.length} CBE fixture(s) fell back to the Receipt ID (FT not extracted):`);
  for (const w of warnings) console.log(`  ${w}`);
}
if (fail > 0) {
  console.log('failures:', failures.join(', '));
  process.exit(1);
}
