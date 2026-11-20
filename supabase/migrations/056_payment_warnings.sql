-- 056: orders.payment_warnings — soft-launch payment verification.
--
-- When checkout payment verification is inconclusive (OCR unreadable,
-- reference not found in verify.et, or verify.et unavailable), the order is
-- placed anyway as a "warning pass" and checkout stamps this column:
-- tenant owner id -> { reason: 'unreadable'|'not_found'|'unavailable', detail? }.
-- Admin surfaces show a "check proof" tag for warned tenants while any of the
-- tenant's items is still pending/received, and the admin orders screen gets a
-- "Needs review" filter built on it. Confirmed-bad verdicts (already_claimed,
-- wrong_amount, wrong_recipient, not-a-receipt) stay hard rejects and never
-- write here; fully verified orders flip their items to paid automatically
-- (see _shared/verifyWorkflow.ts) and never write here either.

ALTER TABLE public.orders
  ADD COLUMN payment_warnings jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.orders.payment_warnings IS
  'tenant id -> {reason, detail?} for orders placed with unconfirmed payment verification (soft-launch warning passes)';
