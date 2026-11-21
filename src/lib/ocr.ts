/**
 * Web-only receipt OCR + QR extraction. NEVER import this module statically —
 * CheckoutScreen loads it with `await import()` behind a Platform.OS === 'web'
 * guard so the wasm/worker machinery stays out of the native bundle. The
 * worker script, wasm core, and language data are all pinned to CDN URLs, so
 * the Metro web export has nothing to bundle beyond the tesseract.js API
 * wrapper itself. jsQR is a tiny pure-JS decoder, safe to bundle.
 *
 * Extraction strategy, in order:
 *   1. QR code on the receipt. Telebirr receipts embed a TLV payload that
 *      contains the exact transaction number; CBE receipts embed either the
 *      legacy FT reference or the modern mbreciept.cbe.com.et Receipt ID.
 *      QR decode is exact — it never misreads 8/B or 0/O like OCR does.
 *   2. Tesseract OCR on the original pixels (preprocessing measured WORSE
 *      on the fixture corpus — Tesseract handles dark-mode screenshots
 *      natively), parsed layout-aware: labeled candidates beat unlabeled
 *      ones, strong per-provider shapes (D… 10 chars, FT… 12 chars) beat
 *      loose shapes, and tokens in a notification banner at the top of the
 *      image are distrusted.
 *   3. A refinement pass: candidate-bearing lines are cropped, upscaled 3x
 *      (bilinear) and re-read with an alphanumeric whitelist and single-line
 *      segmentation, fixing the 0/O, 1/I, 5/S misreads full-page OCR makes.
 *
 * Pure parsing helpers (parseReceiptText, parseReceiptDocument,
 * parseQrPayload and friends) are exported separately from the OCR call so
 * they can be tested without tesseract — see scripts/test-receipt-ocr.mjs,
 * which runs the whole pipeline against the fixture corpus in
 * scripts/receipt-fixtures/.
 */

export type ReceiptProvider = 'cbe' | 'telebirr';

export interface ReceiptParseResult {
  provider?: ReceiptProvider;
  reference?: string;
}

export interface ReceiptOcrResult extends ReceiptParseResult {
  /** False when the OCR text shows no bank brand and no receipt vocabulary —
   *  the shopper uploaded a random image, not a payment receipt. */
  receiptLike: boolean;
  rawText: string;
}

/** One OCR'd word with its position in the (preprocessed) image. */
export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

/** One OCR'd line. */
export interface OcrLine {
  words: OcrWord[];
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** OCR text plus layout geometry. lines is empty for plain-text parsing. */
export interface ReceiptDocument {
  text: string;
  lines: OcrLine[];
  width: number;
  height: number;
}

// tesseract.js v7 pins (must match the installed major version):
// worker script ships with tesseract.js, the wasm core with tesseract.js-core
// and the eng language data with @tesseract.js-data — the same defaults the
// library itself uses, made explicit so nothing is resolved at bundle time.
const TESSERACT_VERSION = '7.0.0';
const WORKER_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js@v${TESSERACT_VERSION}/dist/worker.min.js`;
const CORE_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js-core@v${TESSERACT_VERSION}`;
const LANG_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int';

const TELEBIRR_PATTERN = /tele\s*birr/i;
const CBE_PATTERNS = [/commercial bank of ethiopia/i, /cbe\.com\.et/i, /cbe\s*birr/i];

/** Which provider printed this receipt. Undefined when both or neither brand
 *  shows up in the OCR text — never guessed. */
export function detectProvider(text: string): ReceiptProvider | undefined {
  const isTelebirr = TELEBIRR_PATTERN.test(text);
  const isCbe = CBE_PATTERNS.some((pattern) => pattern.test(text));
  if (isTelebirr === isCbe) return undefined;
  return isTelebirr ? 'telebirr' : 'cbe';
}

// Strong shapes anchor to the observed issuers' formats: every Telebirr
// transaction number in the wild is 10 uppercase chars starting with D
// (DKK8GABD3K); legacy CBE references are FT + 10 (FT26325DKGB7). Both
// require at least one digit — without that, an uppercase NAME like
// "DESSALEW" is indistinguishable from a Telebirr reference. Loose
// shapes are the pre-corpus generic patterns, kept as a fallback for formats
// we have not seen yet; they also require a letter and a digit so amounts,
// dates and words never qualify.
const STRONG_SHAPES: Record<ReceiptProvider, RegExp> = {
  telebirr: /^D(?=[A-Z0-9]*[0-9])[A-Z0-9]{9}$/,
  cbe: /^FT(?=[A-Z0-9]*[0-9])[A-Z0-9]{10}$/i,
};
const LOOSE_SHAPES: Record<ReceiptProvider, RegExp> = {
  telebirr: /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{8,14}$/,
  cbe: /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{10,20}$/,
};

const PROVIDER_LABELS: Record<ReceiptProvider, RegExp> = {
  // Telebirr prints "Transaction No."/"Transaction Number"; the invoice PDF
  // labels the same value "Invoice No." — keep the vocabulary exclusive of
  // CBE's "transaction ID" so the brand-free fallback can't hit both.
  telebirr: /transaction\s*(?:number|no\.?|code)|invoice\s*no\.?|ክፍያ/gi,
  // CBE receipts label it "Receipt ID"/"VAT Receipt No" on the receipt page,
  // "transaction ID" on the in-app success screen and "Reference No. (VAT
  // Invoice No)" on the PDF.
  cbe: /receipt\s*(?:id|no\.?|number)?|transaction\s*id|reference/gi,
};

// Receipt URLs embed the reference: Telebirr's SMS links to
// transactioninfo.ethiotelecom.et/receipt/<ref>, CBE's QR points at
// mbreciept.cbe.com.et/v2-<receipt id>.
const TELEBIRR_URL_REF = /ethiotelecom[^\s]*\/receipt\/([A-Za-z0-9]{8,14})/i;
const CBE_URL_REF = /mbreciept\.cbe\.com\.et\/v2-?([A-Za-z0-9]{8,24})/i;

/** Does the OCR text look like a payment receipt at all? True when a bank
 *  brand shows up (same patterns as detectProvider) or any receipt
 *  vocabulary appears. A random photo — no brand, no vocabulary — yields
 *  false so the caller can reject the upload as "not a receipt". */
export function isReceiptLike(text: string): boolean {
  if (TELEBIRR_PATTERN.test(text) || CBE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  // PROVIDER_LABELS carry the /g flag for matchAll — reset lastIndex before
  // test() so a previous match position can't hide a hit.
  const labeled = Object.values(PROVIDER_LABELS).some((label) => {
    label.lastIndex = 0;
    return label.test(text);
  });
  if (labeled) return true;
    // Brand-free app screens (Telebirr's own success screen never says
  // "Telebirr") still carry amounts, dates and receipt chrome; the SMS
  // receipts carry ethiotelecom URLs and Telebirr's slogan.
  return /\bETB\b|\bBirr\b|debited|transferred|qr code|invoice|ethiotelecom|transactioninfo|where ethiopia shops digitally/i.test(text);
}

/** Whitespace-delimited tokens with OCR punctuation artifacts stripped. */
function tokensOf(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9]/g, ''))
    .filter((token) => token.length > 0);
}

export interface Candidate {
  reference: string;
  provider: ReceiptProvider;
  score: number;
}

/** Score one cleaned token as a reference candidate for a provider. Strong
 *  shapes score 50, loose shapes 20 (telebirr) / 15 (cbe — looser, noisier). */
function shapeScore(token: string, provider: ReceiptProvider): number {
  if (STRONG_SHAPES[provider].test(token)) return 50;
  if (LOOSE_SHAPES[provider].test(token)) return provider === 'telebirr' ? 20 : 15;
  return 0;
}

/** Labeled bonus: the token sits within a short window after one of the
 *  provider's labels ("Transaction No:", "Receipt ID", …). */
function labeledBonus(text: string, token: string, provider: ReceiptProvider): number {
  const labelRegex = PROVIDER_LABELS[provider];
  labelRegex.lastIndex = 0;
  for (const label of text.matchAll(labelRegex)) {
    const window = text.slice(label.index + label[0].length, label.index + label[0].length + 60);
    if (tokensOf(window).includes(token)) return 60;
  }
  return 0;
}

/** A token re-read from cropped, upscaled word/line images. count is how many
 *  independent re-reads produced it. parseReceiptDocument turns this into a
 *  score bonus: re-reads that CONFIRM a full-page token are strong evidence;
 *  conflicting re-reads get a capped bonus so they can rescue a full-page
 *  misread without outvoting a clean labeled hit. */
export interface RefinedToken {
  token: string;
  /** Vertical center in image pixels (for the banner penalty). */
  yCenter?: number;
  count: number;
}

/**
 * Extract provider + transaction reference from an OCR'd receipt. Fields stay
 * undefined when the text is ambiguous — the caller falls back to manual
 * entry instead of verifying a guess. providerHint (the shopper's "Paid
 * via" choice) breaks ties when the receipt prints no brand name — the
 * Telebirr app's own receipt screen never says "Telebirr". refined tokens
 * (from the line-crop second pass) outrank plain full-page reads.
 */
export function parseReceiptDocument(
  doc: ReceiptDocument,
  providerHint?: ReceiptProvider,
  refined: RefinedToken[] = [],
  debugRanked?: (ranked: Candidate[]) => void
): ReceiptParseResult {
  const { text } = doc;
  const brand = detectProvider(text);

  // Gather candidate tokens: geometry-aware when line boxes are available,
  // plain text tokens otherwise.
  interface Positioned { token: string; yCenter?: number }
  const positioned: Positioned[] = [];
  if (doc.lines.length > 0) {
    for (const line of doc.lines) {
      for (const word of line.words) {
        const token = word.text.replace(/[^A-Za-z0-9]/g, '');
        if (token) positioned.push({ token, yCenter: (word.bbox.y0 + word.bbox.y1) / 2 });
      }
    }
  } else {
    for (const token of tokensOf(text)) positioned.push({ token });
  }

  const candidates = new Map<string, Candidate>(); // key: provider:reference
  const bump = (token: string, provider: ReceiptProvider, score: number) => {
    if (score <= 0) return;
    const reference = provider === 'telebirr' ? token.toUpperCase() : token;
    const key = `${provider}:${reference}`;
    const existing = candidates.get(key);
    if (existing) existing.score += score;
    else candidates.set(key, { reference, provider, score });
  };

  // Receipt-URL references are anchored by the URL itself.
  const telebirrUrl = text.match(TELEBIRR_URL_REF);
  if (telebirrUrl) bump(telebirrUrl[1], 'telebirr', 60);
  const cbeUrl = text.match(CBE_URL_REF);
  if (cbeUrl) bump(cbeUrl[1], 'cbe', 60);

  const candidateCount = positioned.filter(
    ({ token }) => shapeScore(token, 'telebirr') > 0 || shapeScore(token, 'cbe') > 0
  ).length;

  const scoreToken = (token: string, yCenter: number | undefined, extra: number) => {
    const providers: ReceiptProvider[] =
      brand ? [brand] : token.startsWith('D') || token.startsWith('d') ? ['telebirr', 'cbe'] : ['cbe', 'telebirr'];
    for (const provider of providers) {
      let score = shapeScore(token, provider);
      if (score === 0) continue;
      score += labeledBonus(text, token, provider) + extra;
      // Notification banners at the top of the screenshot can show SOMEONE
      // ELSE's transaction (different payment, same shape) — distrust any
      // candidate up there when the image offers alternatives.
      if (
        yCenter !== undefined &&
        doc.height > 0 &&
        yCenter < doc.height * 0.18 &&
        candidateCount > 1
      ) {
        score -= 100;
      }
      bump(token, provider, score);
    }
  };

  for (const { token, yCenter } of positioned) scoreToken(token, yCenter, 0);
  // Refinement re-reads (word/line crops, upscaled, charset whitelist):
  // confirming a strong full-page token is strong evidence (+60); a
  // conflicting re-read must be REPEATED (seen in 2+ independent crops) to
  // earn its bonus, so a one-off misread can rescue nothing but also can't
  // outvote a clean full-page read — it just ties, and ties resolve to
  // "no autofill" (the shopper types it manually) instead of a wrong guess.
  // Misreads overwhelmingly flip digits to letters, so ties break toward the
  // candidate with more digits.
  const fullPageTokens = new Set(positioned.map((p) => p.token));
  for (const { token, yCenter, count } of refined) {
    const strong = STRONG_SHAPES.telebirr.test(token) || STRONG_SHAPES.cbe.test(token);
    const bonus = fullPageTokens.has(token) ? (strong ? 60 : 20) : strong ? (count >= 2 ? 40 : 0) : 0;
    scoreToken(token, yCenter, bonus);
  }

  const digitCount = (c: Candidate) => (c.reference.match(/[0-9]/g) ?? []).length;
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || digitCount(b) - digitCount(a));
  debugRanked?.(ranked);
  const best = ranked[0];
  if (!best) return {};
  // A bare loose shape (no label, no URL anchor) is only trusted when it is
  // the single candidate on the whole receipt — ambiguity means undefined.
  const strongEnough = best.score >= 50;
  if (!strongEnough) {
    const anyLabeledOrAnchored = best.score >= 70;
    if (!anyLabeledOrAnchored && ranked.length > 1) return {};
    if (!anyLabeledOrAnchored && ranked.length === 1) {
      // single loose candidate: accept (pre-corpus behavior)
    } else if (anyLabeledOrAnchored && ranked[1] && ranked[1].score === best.score) {
      // tie between labeled candidates
      const hinted = breakTie(ranked, best, providerHint);
      if (hinted) return { provider: hinted.provider, reference: hinted.reference };
      return {};
    }
  }
  if (ranked[1] && ranked[1].score === best.score) {
    const hinted = breakTie(ranked, best, providerHint);
    if (hinted) return { provider: hinted.provider, reference: hinted.reference };
    return {};
  }
  return { provider: best.provider, reference: best.reference };
}

/** Tie-break among same-score candidates: more digits first (OCR misreads
 *  usually flip digits to letters), then the shopper's provider hint. */
function breakTie(
  ranked: Candidate[],
  best: Candidate,
  providerHint?: ReceiptProvider
): Candidate | undefined {
  const tied = ranked.filter((c) => c.score === best.score);
  const digits = (c: Candidate) => (c.reference.match(/[0-9]/g) ?? []).length;
  const maxDigits = Math.max(...tied.map(digits));
  const winners = tied.filter((c) => digits(c) === maxDigits);
  if (winners.length === 1) return winners[0];
  if (providerHint) return winners.find((c) => c.provider === providerHint);
  return undefined;
}

/** Plain-text entry point (no geometry) — kept for callers/tests that only
 *  have OCR text. */
export function parseReceiptText(text: string, providerHint?: ReceiptProvider): ReceiptParseResult {
  return parseReceiptDocument({ text, lines: [], width: 0, height: 0 }, providerHint);
}

/**
 * Parse a decoded QR payload into provider + reference. Returns undefined
 * for payloads we don't recognize (payment QRs, URLs to other sites, …).
 *
 * Telebirr receipts carry a base64'd hex TLV; the transaction number is the
 * 10-char D… ASCII run inside it. CBE receipts carry either the legacy FT
 * reference bare, or the mbreciept.cbe.com.et/v2-<Receipt ID> URL — the
 * modern Receipt ID verify.et accepts without an account suffix.
 */
export function parseQrPayload(payload: string): ReceiptParseResult | undefined {
  const data = payload.trim();
  const cbeUrl = data.match(CBE_URL_REF);
  if (cbeUrl) return { provider: 'cbe', reference: cbeUrl[1] };
  if (STRONG_SHAPES.cbe.test(data) && data.length <= 12) {
    return { provider: 'cbe', reference: data };
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(data) && data.length > 40) {
    try {
      const hex = atob(data);
      if (/^[0-9A-Fa-f]+$/.test(hex) && hex.length % 2 === 0) {
        let raw = '';
        for (let i = 0; i < hex.length; i += 2) {
          raw += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
        const match = raw.match(/D[A-Z0-9]{9}/);
        if (match) return { provider: 'telebirr', reference: match[0] };
      }
    } catch {
      // not base64 — fall through
    }
  }
  return undefined;
}

/** Nearest-neighbor upscale of RGBA pixels (integer factor). Sharp edges are
 *  what QR decoding wants; for OCR crops use scalePixelsSmooth instead —
 *  nearest-neighbor's blocky pixels measurably hurt Tesseract's LSTM. */
export function scalePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  factor: number
): { data: Uint8ClampedArray; width: number; height: number } {
  if (factor <= 1) return { data, width, height };
  const outW = width * factor;
  const outH = height * factor;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const srcRow = Math.floor(y / factor) * width;
    const dstRow = y * outW;
    for (let x = 0; x < outW; x++) {
      const src = (srcRow + Math.floor(x / factor)) * 4;
      const dst = (dstRow + x) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Bilinear upscale of RGBA pixels — smooth edges for OCR line crops. */
export function scalePixelsSmooth(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  factor: number
): { data: Uint8ClampedArray; width: number; height: number } {
  if (factor <= 1) return { data, width, height };
  const outW = Math.round(width * factor);
  const outH = Math.round(height * factor);
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1.001, y / factor);
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1.001, x / factor);
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const dst = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = data[(y0 * width + x0) * 4 + c];
        const p01 = data[(y0 * width + x1) * 4 + c];
        const p10 = data[(y1 * width + x0) * 4 + c];
        const p11 = data[(y1 * width + x1) * 4 + c];
        out[dst + c] =
          p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Crop an RGBA pixel region (clamped to image bounds). */
export function cropPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  box: { x0: number; y0: number; x1: number; y1: number }
): { data: Uint8ClampedArray; width: number; height: number } {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width, Math.ceil(box.x1));
  const y1 = Math.min(height, Math.ceil(box.y1));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * width + x0) * 4;
    out.set(data.subarray(src, src + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Try jsQR at several scales; small QRs in dense PDFs need the upscale. */
export function decodeQrPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  jsQR: (d: Uint8ClampedArray, w: number, h: number, o?: object) => { data: string } | null
): string | undefined {
  for (const factor of [1, 2, 3, 4]) {
    const scaled = scalePixels(data, width, height, factor);
    const code = jsQR(scaled.data, scaled.width, scaled.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (code && code.data) return code.data;
  }
  return undefined;
}

// --- OCR pipeline (worker injected so Node tests drive the real code) ------

interface TesseractBlockLike {
  paragraphs: {
    lines: { words: OcrWord[]; bbox: OcrLine['bbox'] }[];
  }[];
}

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The slice of the tesseract.js worker the pipeline needs. */
export interface OcrWorkerLike {
  recognize(
    image: unknown,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>
  ): Promise<{ data: { text: string; blocks?: TesseractBlockLike[] } }>;
  setParameters(params: Record<string, string>): Promise<unknown>;
}

export interface OcrDeps {
  jsQR: (d: Uint8ClampedArray, w: number, h: number, o?: object) => { data: string } | null;
  createWorker: () => Promise<OcrWorkerLike>;
  /** Encode pixels for the worker: PNG data URI on web, Buffer in Node. */
  encodeImage: (pixels: Pixels) => unknown;
  /** Optional introspection hook (used by scripts/debug-receipt-ocr.mjs). */
  debug?: (info: { text: string; lines: OcrLine[]; refined: RefinedToken[]; ranked: Candidate[] }) => void;
}

// Charset whitelist for the word-crop second pass: reference tokens contain
// only alphanumerics, so punctuation noise can't creep in.
const REFINE_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// Words worth a second look: anything with a shaped token or a D…/FT…
// near-miss (a misread digit can rob a token of its digit, dropping it out
// of the shape patterns entirely). Lines carrying a reference LABEL also
// contribute their own words plus the next line's words (table layouts put
// the value in the row under the label).
const PROBE_TOKEN = /^(?:D[A-Z0-9]{8,11}|FT[A-Z0-9]{8,14})$/i;
const MAX_REFINE_WORDS = 8;

function isProbeToken(token: string): boolean {
  return (
    PROBE_TOKEN.test(token) ||
    shapeScore(token, 'telebirr') > 0 ||
    shapeScore(token, 'cbe') > 0
  );
}

function lineMatchesLabel(line: OcrLine): boolean {
  const lineText = line.words.map((w) => w.text).join(' ');
  return (['telebirr', 'cbe'] as ReceiptProvider[]).some((provider) => {
    PROVIDER_LABELS[provider].lastIndex = 0;
    return PROVIDER_LABELS[provider].test(lineText);
  });
}

/** Pick the words to re-read in the refinement pass, with their line. */
function refinementTargets(lines: OcrLine[]): { word: OcrWord; line: OcrLine }[] {
  const targets: { word: OcrWord; line: OcrLine }[] = [];
  const seen = new Set<OcrWord>();
  const push = (word: OcrWord, line: OcrLine) => {
    if (!seen.has(word) && targets.length < MAX_REFINE_WORDS) {
      seen.add(word);
      targets.push({ word, line });
    }
  };
  lines.forEach((line, i) => {
    for (const word of line.words) {
      const token = word.text.replace(/[^A-Za-z0-9]/g, '');
      if (isProbeToken(token)) push(word, line);
    }
    if (lineMatchesLabel(line)) {
      for (const word of line.words) push(word, line);
      for (const word of lines[i + 1]?.words ?? []) push(word, lines[i + 1]);
    }
  });
  return targets;
}

/**
 * Read receipt pixels and extract the provider + transaction reference:
 * QR first (exact), then full-page OCR, then a refinement pass that crops
 * each candidate-bearing WORD, re-reads it at two upscalings with an
 * alphanumeric whitelist and single-word segmentation, and scores by
 * cross-scale agreement — this fixes the single-character misreads (0/O,
 * 1/I, 5/S, inserted characters) full-page OCR makes on dense receipts.
 * Throws when OCR itself fails (worker load, wasm, network); callers treat
 * that as "unreadable receipt" and fall back to manual entry.
 */
export async function extractReceiptReferenceFromPixels(
  pixels: Pixels,
  providerHint: ReceiptProvider | undefined,
  deps: OcrDeps
): Promise<ReceiptOcrResult> {
  // QR fast path: exact payload, no OCR uncertainty.
  const qrPayload = decodeQrPixels(pixels.data, pixels.width, pixels.height, deps.jsQR);
  if (qrPayload) {
    const fromQr = parseQrPayload(qrPayload);
    if (fromQr?.provider && fromQr.reference) {
      return { ...fromQr, receiptLike: true, rawText: '' };
    }
  }

  const worker = await deps.createWorker();
  try {
    // Full-page pass on the ORIGINAL pixels — Tesseract handles dark-mode
    // screenshots natively, and grayscale/stretch/nearest-upscale
    // preprocessing measurably hurt accuracy on the fixture corpus.
    const { data } = await worker.recognize(deps.encodeImage(pixels), {}, { text: true, blocks: true });
    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          lines.push({ words: line.words ?? [], bbox: line.bbox });
        }
      }
    }
    const doc: ReceiptDocument = { text: data.text, lines, width: pixels.width, height: pixels.height };

    // Refinement pass: re-read candidate-bearing regions from cropped
    // pixels — word crops (PSM single-word) at 2x/4x and line crops (PSM
    // single-line) at 2x/3x. Different crop geometries fail differently, so
    // each region contributes several independent reads; parseReceiptDocument
    // scores them by confirmation and consensus.
    const refined: RefinedToken[] = [];
    const targets = refinementTargets(lines);
    const linesDone = new Set<OcrLine>();
    if (targets.length > 0 && worker.setParameters) {
      const collectReads = async (
        crop: Pixels,
        psm: '7' | '8',
        scales: number[],
        reads: Map<string, number>
      ) => {
        await worker.setParameters({
          tessedit_char_whitelist: REFINE_WHITELIST,
          tessedit_pageseg_mode: psm,
        });
        for (const scale of scales) {
          const zoomed = scalePixelsSmooth(crop.data, crop.width, crop.height, scale);
          const reRead = await worker.recognize(deps.encodeImage(zoomed));
          for (const raw of reRead.data.text.split(/\s+/)) {
            const token = raw.replace(/[^A-Za-z0-9]/g, '');
            if (token && isProbeToken(token)) {
              reads.set(token, (reads.get(token) ?? 0) + 1);
            }
          }
        }
      };
      try {
        for (const { word, line } of targets) {
          const reads = new Map<string, number>();
          const wordCrop = cropPixels(pixels.data, pixels.width, pixels.height, {
            x0: word.bbox.x0 - 6,
            y0: word.bbox.y0 - 6,
            x1: word.bbox.x1 + 6,
            y1: word.bbox.y1 + 6,
          });
          await collectReads(wordCrop, '8', [2, 4], reads);
          if (!linesDone.has(line)) {
            linesDone.add(line);
            const lineCrop = cropPixels(pixels.data, pixels.width, pixels.height, {
              x0: line.bbox.x0 - 8,
              y0: line.bbox.y0 - 8,
              x1: line.bbox.x1 + 8,
              y1: line.bbox.y1 + 8,
            });
            await collectReads(lineCrop, '7', [2, 3], reads);
          }
          const yCenter = (word.bbox.y0 + word.bbox.y1) / 2;
          for (const [token, count] of reads) {
            refined.push({ token, yCenter, count });
          }
        }
      } finally {
        await worker.setParameters({
          tessedit_char_whitelist: '',
          tessedit_pageseg_mode: '3', // PSM.AUTO
        });
      }
    }
    let ranked: Candidate[] = [];
    const result = parseReceiptDocument(doc, providerHint, refined, (r) => (ranked = r));
    deps.debug?.({ text: data.text, lines, refined, ranked });

    return {
      ...result,
      receiptLike: isReceiptLike(data.text),
      rawText: data.text,
    };
  } finally {
    if ('terminate' in worker && typeof worker.terminate === 'function') {
      await (worker as OcrWorkerLike & { terminate: () => Promise<unknown> }).terminate();
    }
  }
}

// --- web-only plumbing below (DOM + tesseract worker) ----------------------

function loadImage(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUri;
  });
}

function imageToPixels(img: HTMLImageElement): Pixels {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

function pixelsToDataUri(pixels: Pixels): string {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Web entry point: read a receipt screenshot (data URI) and extract the
 * provider and transaction reference. See extractReceiptReferenceFromPixels.
 */
export async function extractReceiptReference(
  dataUri: string,
  providerHint?: ReceiptProvider
): Promise<ReceiptOcrResult> {
  const img = await loadImage(dataUri);
  const pixels = imageToPixels(img);
  const { default: jsQR } = await import('jsqr');
  const { createWorker, OEM } = await import('tesseract.js');
  return extractReceiptReferenceFromPixels(pixels, providerHint, {
    jsQR,
    encodeImage: pixelsToDataUri,
    createWorker: () =>
      createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: WORKER_PATH,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
      }) as Promise<OcrWorkerLike>,
  });
}
