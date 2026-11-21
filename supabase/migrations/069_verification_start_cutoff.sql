-- Timor Shop: per-shop payment-verification start date (hard cutoff for receipts).
--
-- Receipts dated BEFORE a shop started verifying payments can never be
-- accepted — not even with a "needs review" warning — because the used-
-- reference ledger (payment_claims, 040/067) has no record of that era and
-- cannot detect reuse. In-era receipts keep the existing rules: the 24h
-- recency check stays a soft 'review'.
--
-- The start date is stamped with a 30-minute grace (now() - 30min) so
-- shoppers who were already mid-purchase when verification was switched on
-- aren't hard-failed for a transfer they made minutes earlier.
--
--   1. profiles.payment_verification_started_at column.
--   2. Backfill: shops already enabled start their era 30 min before this
--      migration runs (correct for production, where verification arrives
--      with this release).
--   3. Trigger stamps the start on every off->on flip — including the
--      admin_set_tenant_payment_verification RPC and direct SQL — and on
--      rows created with verification already on. Re-enabling restarts the
--      era (the ledger's continuity broke while it was off).

-- 1. Column -------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS payment_verification_started_at timestamptz;

-- 2. Backfill -----------------------------------------------------------------

UPDATE public.profiles
SET payment_verification_started_at = now() - interval '30 minutes'
WHERE payment_verification_enabled = true
  AND payment_verification_started_at IS NULL;

-- 3. Stamp trigger --------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.stamp_verification_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- On INSERT OLD is all-NULL, so "enabled with no recorded start" stamps too.
  IF NEW.payment_verification_enabled = true
     AND (OLD.payment_verification_enabled IS DISTINCT FROM true
          OR NEW.payment_verification_started_at IS NULL) THEN
    NEW.payment_verification_started_at := now() - interval '30 minutes';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_stamp_verification_start ON public.profiles;
CREATE TRIGGER profiles_stamp_verification_start
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.stamp_verification_start();
