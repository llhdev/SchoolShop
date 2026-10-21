// Shared payment-verification evaluation, used by both the verify-order-payment
// and verify-et-webhook edge functions. Parsing is deliberately defensive:
// verify.et's completed-result schema is only partially documented, so every
// field is read through a list of candidate keys and the raw payload is stored
// on the attempt row for auditing.

export interface CheckResult {
  result: 'pass' | 'review' | 'fail';
  reason: string;
}

export type OverallStatus = 'pending' | 'verified' | 'needs_review' | 'failed';

export interface ParsedReceipt {
  provider: string | null;
  reference: string | null;
  paidAmount: number | null;
  receiverAccount: string | null;
  payer: string | null;
  transactionDate: string | null;
  verified: boolean;
  processing: boolean;
  settlementMatch: SettlementMatch | null;
}

export interface SettlementMatch {
  matched?: boolean;
  matchedSettlementAccount?: string | null;
  receiverAccount?: string | null;
  ambiguous?: boolean;
  reason?: string;
}

/** Digits-only account/phone comparison — verifies.et and tenants record the
 *  same account with different spacing or the +251/0 phone prefix. */
export function normalizeAccount(value: string | null | undefined): string {
  if (!value) return '';
  let digits = value.replace(/\D/g, '');
  // Ethiopian phone canonicalization: 2519XXXXXXXX / +2519... -> 09...
  if (digits.startsWith('251') && digits.length === 12) digits = `0${digits.slice(3)}`;
  return digits;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[,\sETB]/gi, '');
    const n = Number(cleaned);
    if (cleaned && Number.isFinite(n)) return n;
  }
  return null;
}

/** Extract the most useful result item from a verify.et response/webhook
 *  payload (completed results arrive in a data array on API responses, as a
 *  data object on webhook events, or on verification). */
export function extractResultItem(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const data = p.data;
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
    return data[0] as Record<string, unknown>;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (p.verification && typeof p.verification === 'object') {
    return p.verification as Record<string, unknown>;
  }
  return null;
}

export function parseReceipt(item: Record<string, unknown>): ParsedReceipt {
  const status = firstString(item.status, item.processingStatus)?.toLowerCase() ?? '';
  const sam =
    item.settlementAccountMatch && typeof item.settlementAccountMatch === 'object'
      ? (item.settlementAccountMatch as SettlementMatch)
      : null;
  return {
    provider: firstString(item.bank, item.provider),
    reference: firstString(
      item.reference,
      item.transactionNumber,
      item.transaction_reference,
      item.receiptNumber,
      item.referenceNumber
    ),
    paidAmount: parseAmount(
      item.amount ?? item.paidAmount ?? item.totalAmount ?? item.transactionAmount
    ),
    receiverAccount:
      firstString(item.receiverAccount, item.receiver_account, sam?.receiverAccount) ?? null,
    payer: firstString(
      item.payerName,
      item.senderName,
      item.payer_name,
      (item.payer as Record<string, unknown> | undefined)?.name
    ),
    transactionDate: firstString(
      item.transactionDate,
      item.transaction_date,
      item.paidAt,
      item.paid_at,
      item.date,
      item.timestamp
    ),
    verified:
      item.verified === true ||
      status === 'verified' ||
      status === 'success' ||
      status === 'completed',
    processing:
      status === 'pending' || status === 'processing' || status === 'queued' || status === '',
    settlementMatch: sam,
  };
}

export type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'same_order' }
  | { kind: 'other_order'; holderOrderId: string }
  | { kind: 'not_attempted' };

export interface EvaluationInput {
  receipt: ParsedReceipt;
  /** The merchant's own account numbers/phones (profiles.bank_accounts). */
  merchantAccounts: string[];
  expectedAmount: number;
  orderCreatedAt: string;
  claimOutcome: ClaimOutcome;
  maxAgeHours: number;
}

export interface Evaluation {
  checks: Record<string, CheckResult>;
  overall: OverallStatus;
}

const MASKED_MATCH_REASONS = new Set([
  'receiver_mask_matches_visible_digits',
  'receiver_suffix_matches',
]);

/** Match a masked receiver (e.g. `1****8566`, `2519****0897`) against the
 *  merchant's own accounts by visible prefix+suffix digits — the same rule
 *  verify.et applies for its registry matches, done locally so recipient
 *  confirmation does not depend on the registry sync. Phone accounts are
 *  compared in both 09… and 2519… forms. Returns the matching accounts. */
export function matchMaskedAccounts(mask: string, merchantNorms: string[]): string[] {
  const [pre = '', suf = ''] = mask.split(/\*+/).map((s) => s.replace(/\D/g, ''));
  if (!pre && !suf) return [];
  return merchantNorms.filter((account) => {
    const forms = [account];
    if (account.startsWith('0') && account.length === 10) forms.push(`251${account.slice(1)}`);
    return forms.some((f) => f.startsWith(pre) && f.endsWith(suf));
  });
}

export function evaluateChecks(input: EvaluationInput): Evaluation {
  const { receipt, merchantAccounts, expectedAmount, orderCreatedAt, claimOutcome, maxAgeHours } =
    input;
  const checks: Record<string, CheckResult> = {};
  const merchantNorms = merchantAccounts.map(normalizeAccount).filter(Boolean);

  // 1. Payment completed -----------------------------------------------------
  if (receipt.processing) {
    checks.paymentComplete = { result: 'review', reason: 'verification still processing' };
  } else if (receipt.verified) {
    checks.paymentComplete = {
      result: 'pass',
      reason: `confirmed by provider${receipt.provider ? ` (${receipt.provider})` : ''}`,
    };
  } else {
    checks.paymentComplete = { result: 'fail', reason: 'transaction not found or not completed' };
  }

  // 2. Recipient matches THIS merchant's account ------------------------------
  const sam = receipt.settlementMatch ?? null;
  const matchedAccountNorm = normalizeAccount(sam?.matchedSettlementAccount);
  const receiverNorm = normalizeAccount(receipt.receiverAccount);
  // Local masked-receiver matching: verify.et (and the providers themselves)
  // often return only a masked receiver like 1****8566 — resolve it against
  // this shop's accounts by visible digits instead of giving up.
  const maskSource = sam?.receiverAccount ?? receipt.receiverAccount;
  const localMaskMatches =
    maskSource?.includes('*') && merchantNorms.length > 0
      ? matchMaskedAccounts(maskSource, merchantNorms)
      : [];

  if (sam?.ambiguous) {
    checks.recipientMatch = { result: 'review', reason: 'ambiguous masked receiver — confirm manually' };
  } else if (
    sam?.reason === 'receiver_account_exact_match' &&
    matchedAccountNorm &&
    merchantNorms.includes(matchedAccountNorm)
  ) {
    checks.recipientMatch = { result: 'pass', reason: `paid to this shop's account` };
  } else if (sam?.reason === 'receiver_account_exact_match' && matchedAccountNorm) {
    checks.recipientMatch = {
      result: 'fail',
      reason: 'paid to a different account than this shop\'s',
    };
  } else if (sam?.reason && MASKED_MATCH_REASONS.has(sam.reason)) {
    // Wallet providers (Telebirr) never reveal the full receiver, so a masked
    // match is the strongest signal available: conclusive when the matched
    // account is (or is not) this shop's, in either direction.
    if (matchedAccountNorm && merchantNorms.includes(matchedAccountNorm)) {
      checks.recipientMatch = {
        result: 'pass',
        reason: `paid to this shop's account (matched by visible digits)`,
      };
    } else if (matchedAccountNorm) {
      checks.recipientMatch = {
        result: 'fail',
        reason: 'paid to a different registered account than this shop\'s',
      };
    } else if (localMaskMatches.length === 1) {
      checks.recipientMatch = {
        result: 'pass',
        reason: `paid to this shop's account (matched by visible digits)`,
      };
    } else if (localMaskMatches.length > 1) {
      checks.recipientMatch = { result: 'review', reason: 'ambiguous masked receiver — confirm manually' };
    } else if (merchantNorms.length > 0) {
      checks.recipientMatch = {
        result: 'fail',
        reason: `paid to a different account than this shop's (receiver ${maskSource})`,
      };
    } else {
      checks.recipientMatch = {
        result: 'review',
        reason: 'masked account digits are not proof of recipient — confirm manually',
      };
    }
  } else if (receiverNorm && !receipt.receiverAccount?.includes('*') && merchantNorms.includes(receiverNorm)) {
    checks.recipientMatch = { result: 'pass', reason: `paid to this shop's account` };
  } else if (receiverNorm && receipt.receiverAccount?.includes('*')) {
    if (localMaskMatches.length === 1) {
      checks.recipientMatch = {
        result: 'pass',
        reason: `paid to this shop's account (matched by visible digits)`,
      };
    } else if (localMaskMatches.length > 1) {
      checks.recipientMatch = { result: 'review', reason: 'ambiguous masked receiver — confirm manually' };
    } else if (merchantNorms.length > 0) {
      checks.recipientMatch = {
        result: 'fail',
        reason: `paid to a different account than this shop's (receiver ${receipt.receiverAccount})`,
      };
    } else {
      checks.recipientMatch = {
        result: 'review',
        reason: `receiver account is masked (${receipt.receiverAccount}) — confirm manually`,
      };
    }
  } else {
    checks.recipientMatch = {
      result: 'review',
      reason: `receiver account could not be confirmed — check manually (verify.et: ${sam?.reason ?? 'no settlement data'}${receipt.receiverAccount ? `, receiver ${receipt.receiverAccount}` : ''})`,
    };
  }

  // 3. Exact amount (items + delivery fee) ------------------------------------
  if (receipt.paidAmount === null) {
    checks.amountMatch = { result: 'review', reason: 'amount not present on the receipt result' };
  } else if (receipt.paidAmount === expectedAmount) {
    checks.amountMatch = { result: 'pass', reason: `${formatBirr(receipt.paidAmount)} exact` };
  } else if (receipt.paidAmount < expectedAmount) {
    checks.amountMatch = {
      result: 'fail',
      reason: `underpaid: ${formatBirr(receipt.paidAmount)} of ${formatBirr(expectedAmount)}`,
    };
  } else {
    checks.amountMatch = {
      result: 'review',
      reason: `overpaid: ${formatBirr(receipt.paidAmount)} vs expected ${formatBirr(expectedAmount)}`,
    };
  }

  // 4. Not previously claimed --------------------------------------------------
  switch (claimOutcome.kind) {
    case 'claimed':
      checks.notPreviouslyClaimed = { result: 'pass', reason: 'first use of this transaction' };
      break;
    case 'same_order':
      checks.notPreviouslyClaimed = { result: 'pass', reason: 'claimed by this order (retry)' };
      break;
    case 'other_order':
      checks.notPreviouslyClaimed = {
        result: 'fail',
        reason: `already used for order ${claimOutcome.holderOrderId}`,
      };
      break;
    case 'not_attempted':
      checks.notPreviouslyClaimed = {
        result: 'pass',
        reason: 'not claimed — claims are created only for fully verified payments',
      };
      break;
  }

  // 5. Receipt ownership / recency ---------------------------------------------
  if (!receipt.transactionDate) {
    checks.receiptOwnership = {
      result: 'review',
      reason: 'transaction date not available — confirm receipt manually',
    };
  } else {
    const txn = new Date(receipt.transactionDate);
    const ordered = new Date(orderCreatedAt);
    if (Number.isNaN(txn.getTime())) {
      checks.receiptOwnership = {
        result: 'review',
        reason: 'transaction date unreadable — confirm receipt manually',
      };
    } else if (txn.getTime() > ordered.getTime() + 10 * 60 * 1000) {
      checks.receiptOwnership = { result: 'review', reason: 'receipt is dated after the order' };
    } else if (ordered.getTime() - txn.getTime() > maxAgeHours * 3600 * 1000) {
      checks.receiptOwnership = {
        result: 'review',
        reason: `receipt is older than ${maxAgeHours}h before the order`,
      };
    } else {
      checks.receiptOwnership = {
        result: 'pass',
        reason: receipt.payer ? `recent receipt · payer: ${receipt.payer}` : 'recent receipt',
      };
    }
  }

  const results = Object.values(checks).map((c) => c.result);
  let overall: OverallStatus = 'verified';
  if (checks.paymentComplete.reason === 'verification still processing') {
    overall = 'pending';
  } else if (results.includes('fail')) {
    overall = 'failed';
  } else if (results.includes('review')) {
    overall = 'needs_review';
  }
  return { checks, overall };
}

export function formatBirr(amount: number): string {
  return `${Math.round(amount).toLocaleString('en-US')} ETB`;
}
