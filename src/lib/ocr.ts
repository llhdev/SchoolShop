/**
 * Web-only receipt OCR (Tesseract.js). NEVER import this module statically —
 * CheckoutScreen loads it with `await import()` behind a Platform.OS === 'web'
 * guard so the wasm/worker machinery stays out of the native bundle. The
 * worker script, wasm core, and language data are all pinned to CDN URLs, so
 * the Metro web export has nothing to bundle beyond the tesseract.js API
 * wrapper itself.
 *
 * Pure parsing helpers (parseReceiptText and friends) are exported separately
 * from the OCR call so they can be tested without tesseract.
 */

export type ReceiptProvider = 'cbe' | 'telebirr';

export interface ReceiptParseResult {
  provider?: ReceiptProvider;
  reference?: string;
}

export interface ReceiptOcrResult extends ReceiptParseResult {
  rawText: string;
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

// Telebirr transaction number: 8-14 char uppercase alphanumeric (DET8FJGUJ4).
// CBE Receipt ID: 10-20 char mixed-case alphanumeric (fHCxyExampleRcpt1).
// Both must contain a letter and a digit so amounts, dates and words never
// qualify.
const REFERENCE_SHAPES: Record<ReceiptProvider, RegExp> = {
  telebirr: /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{8,14}$/,
  cbe: /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{10,20}$/,
};

const PROVIDER_LABELS: Record<ReceiptProvider, RegExp> = {
  telebirr: /transaction\s*(?:number|no\.?|id|code)?|ክፍያ/gi,
  cbe: /receipt\s*(?:id|no\.?|number)?|reference/gi,
};

/** Whitespace-delimited tokens with OCR punctuation artifacts stripped. */
function tokensOf(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9]/g, ''))
    .filter((token) => token.length > 0);
}

/** First shape-matching token within a short window after a label
 *  ("Transaction No:", "Receipt ID", …). Labeled hits beat shape guesses. */
function findLabeledReference(
  text: string,
  labelRegex: RegExp,
  shape: RegExp
): string | undefined {
  for (const label of text.matchAll(labelRegex)) {
    const window = text.slice(label.index + label[0].length, label.index + label[0].length + 40);
    const candidate = tokensOf(window).find((token) => shape.test(token));
    if (candidate) return candidate;
  }
  return undefined;
}

/** Unlabeled fallback: the token only counts when it is the single
 *  shape-matching candidate on the whole receipt — ambiguity means undefined. */
function findShapeReference(text: string, shape: RegExp): string | undefined {
  const candidates = [...new Set(tokensOf(text).filter((token) => shape.test(token)))];
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Extract provider + transaction reference from raw OCR text. Fields stay
 *  undefined when the text is ambiguous — the caller falls back to manual
 *  entry instead of verifying a guess. */
export function parseReceiptText(text: string): ReceiptParseResult {
  const provider = detectProvider(text);
  if (!provider) return {};
  const shape = REFERENCE_SHAPES[provider];
  const raw =
    findLabeledReference(text, PROVIDER_LABELS[provider], shape) ??
    findShapeReference(text, shape);
  // Telebirr prints transaction numbers uppercase; normalize OCR case noise.
  const reference = provider === 'telebirr' && raw ? raw.toUpperCase() : raw;
  return { provider, reference };
}

/**
 * OCR a receipt screenshot (data URI) and extract the provider and
 * transaction reference. Throws when OCR itself fails (worker load, wasm,
 * network); callers treat that as "unreadable receipt" and fall back to
 * manual entry.
 */
export async function extractReceiptReference(dataUri: string): Promise<ReceiptOcrResult> {
  const { createWorker, OEM } = await import('tesseract.js');
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
  });
  try {
    const { data } = await worker.recognize(dataUri);
    return { ...parseReceiptText(data.text), rawText: data.text };
  } finally {
    await worker.terminate();
  }
}
