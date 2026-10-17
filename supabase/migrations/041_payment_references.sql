-- Timor Shop: pre-order payment-reference verification.
-- Run after 040_payment_verifications.sql.
--
-- Checkout now verifies each shop's payment BEFORE the order exists: the
-- client reads the transaction reference off the proof screenshot (OCR on
-- web, manual entry elsewhere) and calls the verify-payment-reference edge
-- function, which checks the reference against verify.et read-only — no
-- payment_claims / payment_verifications rows are written pre-order. The
-- verified { provider, reference, key } triple per tenant is stored on the
-- order (payment_references); the AFTER INSERT trigger's
-- verify-order-payment then replays the same idempotency key (a free replay
-- on verify.et's side) and performs the authoritative atomic claim and
-- history write exactly as before. Orders without payment_references keep
-- the legacy image-based path.

-- ---------------------------------------------------------------------------
-- 1. orders.payment_references: tenant owner id (uuid as text key) ->
--    { provider, reference, key }. '{}' = legacy order, image path applies.
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_references jsonb NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- 2. payment_prechecks: one row per pre-order verification call. The unique
--    idempotency key makes same-key retries return the stored verdict
--    without a new verify.et call, and counting today's rows enforces the
--    function's daily submission cap. Service-role only: RLS enabled with
--    NO policies, so anon/authenticated roles have no access.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_prechecks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  reference text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  verdict jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_prechecks ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Orders are inserted by anonymous clients (public INSERT policy), so the
--    client-supplied created_at cannot be trusted — a crafted client could
--    backdate it to make a stale receipt pass the receipt-ownership check.
--    Force the server's clock on every insert; legit clients always send
--    ~now anyway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.force_order_created_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_created_at ON public.orders;
CREATE TRIGGER trg_orders_created_at
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.force_order_created_at();
