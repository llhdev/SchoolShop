-- Timor Shop: automated payment-proof verification via verify.et.
-- Run after 039_order_status_from_items.sql.
--
-- When an order is placed, each merchant's payment proof is verified
-- server-side (supabase/functions/verify-order-payment): payment completed,
-- correct recipient, exact amount, not previously claimed, receipt recency.
-- Results are kept per attempt in payment_verifications (full history; the
-- current attempt is flagged), and successfully verified transactions are
-- recorded in payment_claims so a reference can never pay for two orders.
--
-- One-time setup outside this file (documented, not automated):
--   SELECT vault.create_secret('<secret>', 'verify_function_secret');
--   (same value as the VERIFY_FUNCTION_SECRET Supabase edge-function secret;
--    the trigger below refuses to fire without it)
--
-- The proofs themselves move to a PRIVATE bucket (payment-proofs-private)
-- created at the bottom of this file; the legacy public payment-proofs
-- bucket is left untouched for existing orders.

-- ---------------------------------------------------------------------------
-- 1. payment_claims: one row per claimed transaction reference.
--    Inserted ONLY when paymentComplete + recipientMatch + amountMatch all
--    passed (or on manual approval), via one atomic INSERT ... ON CONFLICT.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_claims (
  provider text NOT NULL,
  reference text NOT NULL,
  order_id text NOT NULL,
  tenant_id uuid NOT NULL,
  verification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, reference)
);

ALTER TABLE public.payment_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read payment claims" ON public.payment_claims;
CREATE POLICY "Admins read payment claims"
  ON public.payment_claims FOR SELECT TO authenticated
  USING (public.is_super_admin() OR tenant_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. payment_verifications: one row per verification ATTEMPT (audit history).
--    Exactly one current attempt per (order, merchant).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  attempt_no integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'needs_review', 'failed', 'error')),
  checks jsonb NOT NULL DEFAULT '{}',
  expected_amount numeric,
  paid_amount numeric,
  provider text,
  reference text,
  receiver_account text,
  payer text,
  transaction_date timestamptz,
  request_id text,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_verifications_one_current
  ON public.payment_verifications (order_id, tenant_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS payment_verifications_request_id
  ON public.payment_verifications (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE public.payment_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read payment verifications" ON public.payment_verifications;
CREATE POLICY "Admins read payment verifications"
  ON public.payment_verifications FOR SELECT TO authenticated
  USING (public.is_super_admin() OR tenant_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Trusted trigger: AFTER INSERT on orders, ask the edge function to verify
--    every proof on the order. The client never calls the function; it only
--    accepts our internal token, so public traffic cannot burn verify.et
--    credits. Requires pg_net and the app.verify_function_secret setting.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Shared secret reader: the internal token lives in Supabase Vault, readable
-- only by SECURITY DEFINER functions owned by postgres.
CREATE OR REPLACE FUNCTION public.verify_function_secret()
RETURNS text AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'verify_function_secret'
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trigger_verify_order_payment()
RETURNS trigger AS $$
DECLARE
  secret text := public.verify_function_secret();
  fn_url text := COALESCE(
    current_setting('app.supabase_functions_url', true),
    'https://mzdprnvazllhfaxteeyk.supabase.co/functions/v1'
  );
BEGIN
  -- Only orders carrying at least one payment proof need verification.
  IF NEW.payment_proofs IS NULL OR NEW.payment_proofs = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  IF secret IS NULL OR secret = '' THEN
    RAISE WARNING 'verify_function_secret not in vault; payment verification not triggered for order %', NEW.id;
    RETURN NEW;
  END IF;
  PERFORM net.http_post(
    url := fn_url || '/verify-order-payment',
    body := jsonb_build_object('order_id', NEW.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-token', secret
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_orders_verify_payment ON public.orders;
CREATE TRIGGER trg_orders_verify_payment
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.trigger_verify_order_payment();

-- Shared internal POST so the retry RPC and trigger stay in sync.
CREATE OR REPLACE FUNCTION public.request_payment_verification(p_order_id text)
RETURNS void AS $$
DECLARE
  secret text := public.verify_function_secret();
  fn_url text := COALESCE(
    current_setting('app.supabase_functions_url', true),
    'https://mzdprnvazllhfaxteeyk.supabase.co/functions/v1'
  );
BEGIN
  IF secret IS NULL OR secret = '' THEN
    RAISE EXCEPTION 'verify_function_secret is not set in vault.';
  END IF;
  PERFORM net.http_post(
    url := fn_url || '/verify-order-payment',
    body := jsonb_build_object('order_id', p_order_id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-token', secret
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------------
-- 4. retry_payment_verification: super admin or the owning tenant re-runs
--    verification (replacement screenshot, error recovery, stale pending).
--    The edge function opens the next attempt; replays of the same image are
--    free thanks to the idempotency key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_payment_verification(
  p_order_id text,
  p_tenant_id uuid
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() AND auth.uid() <> p_tenant_id THEN
    RAISE EXCEPTION 'Only the super admin or the owning tenant can retry verification.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = p_order_id AND payment_proofs ? p_tenant_id::text
  ) THEN
    RAISE EXCEPTION 'Order not found, or it has no payment proof for this tenant.';
  END IF;
  PERFORM public.request_payment_verification(p_order_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.retry_payment_verification(text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. approve_payment_verification: merchant authority for needs_review
--    results. Atomically claims the reference (rejecting if another order
--    claimed it meanwhile), then marks the current attempt verified.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_payment_verification(
  p_order_id text,
  p_tenant_id uuid
)
RETURNS void AS $$
DECLARE
  v public.payment_verifications%ROWTYPE;
  claimed_order text;
BEGIN
  IF NOT public.is_super_admin() AND auth.uid() <> p_tenant_id THEN
    RAISE EXCEPTION 'Only the super admin or the owning tenant can approve a payment.';
  END IF;

  SELECT * INTO v FROM public.payment_verifications
  WHERE order_id = p_order_id AND tenant_id = p_tenant_id AND is_current
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No verification found for this order and tenant.';
  END IF;
  IF v.status = 'verified' THEN
    RETURN; -- already approved/verified; idempotent
  END IF;
  IF v.status <> 'needs_review' THEN
    RAISE EXCEPTION 'Only payments flagged for review can be approved (current status: %).', v.status;
  END IF;

  -- Manual approval must also prevent duplicate use: claim the reference
  -- atomically, rejecting if another order got there first.
  IF v.provider IS NOT NULL AND v.reference IS NOT NULL THEN
    INSERT INTO public.payment_claims (provider, reference, order_id, tenant_id, verification_id)
    VALUES (v.provider, v.reference, p_order_id, p_tenant_id, v.id)
    ON CONFLICT (provider, reference) DO NOTHING
    RETURNING order_id INTO claimed_order;

    IF claimed_order IS NULL THEN
      SELECT order_id INTO claimed_order FROM public.payment_claims
      WHERE provider = v.provider AND reference = v.reference;
      IF claimed_order IS DISTINCT FROM p_order_id THEN
        RAISE EXCEPTION 'This transaction was already claimed by order %.', claimed_order;
      END IF;
    END IF;
  END IF;

  UPDATE public.payment_verifications
  SET status = 'verified',
      checks = checks || jsonb_build_object(
        'notPreviouslyClaimed', jsonb_build_object('result', 'pass', 'reason', 'claimed on manual approval'),
        'manualApproval', jsonb_build_object('result', 'pass', 'reason', 'approved by merchant')
      ),
      updated_at = now()
  WHERE id = v.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.approve_payment_verification(text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Private bucket for new payment proofs. Existing orders keep their public
--    payment-proofs URLs; new uploads store the object path from this bucket
--    and are read via the service role (edge functions) or short-lived signed
--    URLs (admin order detail). Shoppers upload unauthenticated, so INSERT is
--    public; SELECT is authenticated-only (the app's authenticated users are
--    all admins).
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-proofs-private', 'payment-proofs-private', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public upload payment proofs" ON storage.objects;
CREATE POLICY "Public upload payment proofs"
  ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'payment-proofs-private');

DROP POLICY IF EXISTS "Admins read payment proofs" ON storage.objects;
CREATE POLICY "Admins read payment proofs"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'payment-proofs-private');
