// Regression tests for the verify.et response parsing shared by
// verify-order-payment, verify-et-webhook, verify-payment-reference and
// manual-verify-reference.
// Guards the Nov 2026 bug class: telebirr completed results arriving nested
// as { data: { bank, result: {...} } } — extractResultItem returned the outer
// data object, parseReceipt found no fields, and genuinely successful
// payments were recorded as needs_review ("no settlement data"). Several
// fields (reference, receiver, amount, date) also exist ONLY inside
// bankSpecific, even in the envelope shapes that parsed.
//
// Imports the REAL shared module the deployed edge functions use
// (supabase/functions/_shared/verifyEvaluation.ts) — no copied logic.
// Requires Node >= 22.18 (native TypeScript type stripping).
//
// Fixtures are redacted versions of real prod payment_verifications.raw
// payloads — names/accounts replaced with placeholders. Keep real PII OUT
// when adding new ones.
//
// Run: node scripts/test-verify-evaluation.mjs

import assert from 'node:assert/strict';
import { extractResultItem, parseReceipt } from '../supabase/functions/_shared/verifyEvaluation.ts';

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

// --- fixtures (redacted captures from prod payment_verifications.raw) -------

// The shape that was mis-recorded as needs_review: receipt nested one level
// deeper inside data.result.
const NESTED_TELEBIRR = {
  data: {
    bank: 'telebirr',
    result: {
      bank: 'telebirr',
      amount: 1000,
      status: 'success',
      currency: 'ETB',
      verified: true,
      timestamp: '2026-11-12T09:04:30.000Z',
      senderName: 'PAYER NAME',
      bankSpecific: {
        source: 'proxy',
        amountRaw: '1,000 Birr',
        payerName: 'PAYER NAME',
        receiptNo: 'DKC63CKXYE',
        reference: 'DKC63CKXYE',
        receiptNumber: 'DKC63CKXYE',
        amountValue: 1000,
        paymentDate: '12-11-2026 12:04:30',
        paymentDateIsoUtc: '2026-11-12T09:04:30.000Z',
        receiverAccount: '2519****3463',
        receiverName: 'SHOP OWNER NAME',
        settledAmountValue: 1000,
        transactionStatus: 'Completed',
      },
    },
  },
};

// The shape that always worked: flat item in a data array, fields top-level.
const ARRAY_TELEBIRR = {
  data: [
    {
      bank: 'telebirr',
      amount: 300,
      status: 'success',
      currency: 'ETB',
      verified: true,
      reference: 'CHABC12345',
      timestamp: '2026-11-24T03:59:26.000Z',
      senderName: 'PAYER NAME',
      receiverAccount: '2519****3463',
      bankSpecific: {
        payerName: 'PAYER NAME',
        receiptNo: 'CHABC12345',
        reference: 'CHABC12345',
        amountValue: 300,
        paymentDate: '24-11-2026 06:59:26',
        paymentDateIsoUtc: '2026-11-24T03:59:26.000Z',
        receiverAccount: '2519****3463',
        receiverName: 'SHOP OWNER NAME',
        transactionStatus: 'Completed',
      },
    },
  ],
};

// Same flat array item but WITHOUT any top-level reference — some verified
// rows only carry it inside bankSpecific (latent gap in the old parser).
const ARRAY_NO_TOP_REFERENCE = {
  data: [
    {
      bank: 'telebirr',
      status: 'Completed',
      verified: true,
      senderName: 'PAYER NAME',
      bankSpecific: {
        reference: 'DKC63CKXYE',
        amountValue: 450,
        paymentDateIsoUtc: '2026-11-20T14:00:00.000Z',
        receiverAccount: '2519****3463',
      },
    },
  ],
};

console.log('extractResultItem — envelope unwrapping');

test('nested { data: { bank, result } } unwraps to the inner result', () => {
  const item = extractResultItem(NESTED_TELEBIRR);
  assert.ok(item);
  assert.equal(item.bank, 'telebirr');
  assert.equal(item.status, 'success');
  assert.equal(item.amount, 1000);
  assert.ok(item.bankSpecific);
});

test('data array still returns the first item', () => {
  const item = extractResultItem(ARRAY_TELEBIRR);
  assert.ok(item);
  assert.equal(item.amount, 300);
});

test('verification envelope still unwraps', () => {
  const item = extractResultItem({ verification: { status: 'verified', bank: 'cbe' } });
  assert.ok(item);
  assert.equal(item.status, 'verified');
});

test('plain data object (not_found) still returns the data object itself', () => {
  const item = extractResultItem({ data: { bank: 'telebirr', status: 'not_found' } });
  assert.ok(item);
  assert.equal(item.status, 'not_found');
});

test('data object with a null result is NOT unwrapped', () => {
  const item = extractResultItem({ data: { bank: 'telebirr', status: 'not_found', result: null } });
  assert.ok(item);
  assert.equal(item.status, 'not_found');
});

test('garbage payloads return null', () => {
  for (const garbage of [null, undefined, 'string', 42, {}, { data: [] }, { data: null }]) {
    assert.equal(extractResultItem(garbage), null, JSON.stringify(garbage));
  }
});

console.log('\nparseReceipt — nested telebirr shape (the prod failure)');

test('extracts every field from the nested shape', () => {
  const receipt = parseReceipt(extractResultItem(NESTED_TELEBIRR));
  assert.equal(receipt.provider, 'telebirr');
  assert.equal(receipt.reference, 'DKC63CKXYE');
  assert.equal(receipt.paidAmount, 1000);
  assert.equal(receipt.receiverAccount, '2519****3463');
  assert.equal(receipt.payer, 'PAYER NAME');
  assert.equal(receipt.transactionDate, '2026-11-12T09:04:30.000Z');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.processing, false);
});

test('also parses when the outer data object reaches parseReceipt directly', () => {
  const receipt = parseReceipt(NESTED_TELEBIRR.data);
  assert.equal(receipt.reference, 'DKC63CKXYE');
  assert.equal(receipt.paidAmount, 1000);
  assert.equal(receipt.processing, false);
  assert.equal(receipt.verified, true);
});

console.log('\nparseReceipt — existing shapes keep working');

test('flat array item parses top-level fields', () => {
  const receipt = parseReceipt(extractResultItem(ARRAY_TELEBIRR));
  assert.equal(receipt.provider, 'telebirr');
  assert.equal(receipt.reference, 'CHABC12345');
  assert.equal(receipt.paidAmount, 300);
  assert.equal(receipt.receiverAccount, '2519****3463');
  assert.equal(receipt.payer, 'PAYER NAME');
  assert.equal(receipt.transactionDate, '2026-11-24T03:59:26.000Z');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.processing, false);
});

test('reference/amount fall back to bankSpecific when top-level keys are absent', () => {
  const receipt = parseReceipt(extractResultItem(ARRAY_NO_TOP_REFERENCE));
  assert.equal(receipt.reference, 'DKC63CKXYE');
  assert.equal(receipt.paidAmount, 450);
  assert.equal(receipt.receiverAccount, '2519****3463');
  assert.equal(receipt.transactionDate, '2026-11-20T14:00:00.000Z');
  assert.equal(receipt.processing, false);
});

console.log('\nparseReceipt — dates');

test('top-level timestamp wins over bankSpecific dates', () => {
  const receipt = parseReceipt(extractResultItem(NESTED_TELEBIRR));
  assert.equal(receipt.transactionDate, '2026-11-12T09:04:30.000Z');
});

test("DD-MM-YYYY HH:mm:ss local date is converted when no ISO field exists", () => {
  const receipt = parseReceipt({
    bank: 'telebirr',
    status: 'success',
    bankSpecific: { paymentDate: '12-11-2026 12:04:30' },
  });
  assert.equal(receipt.transactionDate, '2026-11-12T12:04:30');
  assert.ok(!Number.isNaN(new Date(receipt.transactionDate).getTime()));
});

test('transactionDateRaw works as a local-date fallback too', () => {
  const receipt = parseReceipt({
    bank: 'telebirr',
    status: 'success',
    bankSpecific: { transactionDateRaw: '01-01-2026 08:30:00' },
  });
  assert.equal(receipt.transactionDate, '2026-01-01T08:30:00');
});

test('unparseable local date yields null, not garbage', () => {
  const receipt = parseReceipt({
    bank: 'telebirr',
    status: 'success',
    bankSpecific: { paymentDate: 'Nov 12, 2026' },
  });
  assert.equal(receipt.transactionDate, null);
});

console.log('\nparseReceipt — status mapping');

test("'Completed' status counts as verified, not processing", () => {
  const receipt = parseReceipt({ bank: 'telebirr', status: 'Completed' });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.processing, false);
});

test('pending/processing statuses still count as processing', () => {
  for (const status of ['pending', 'processing', 'queued']) {
    assert.equal(parseReceipt({ status }).processing, true, status);
  }
});

test('empty/garbage item returns all-null fields safely', () => {
  const receipt = parseReceipt({});
  assert.equal(receipt.provider, null);
  assert.equal(receipt.reference, null);
  assert.equal(receipt.paidAmount, null);
  assert.equal(receipt.receiverAccount, null);
  assert.equal(receipt.payer, null);
  assert.equal(receipt.transactionDate, null);
  assert.equal(receipt.verified, false);
  assert.equal(receipt.processing, true);
  assert.equal(receipt.settlementMatch, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
