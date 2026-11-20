-- Timor Shop: per-environment edge-function base URL for payment verification (066).
-- Run after 065_drop_legacy_orders_read_policy.sql.
--
-- 040's trigger_verify_order_payment / request_payment_verification built the
-- verify-order-payment URL from current_setting('app.supabase_functions_url')
-- with a hardcoded PROD fallback (https://mzdprnvazllhfaxteeyk.supabase.co).
-- The setting is never set anywhere, so on STAGING the DB trigger posted
-- staging order ids to the PROD function, where they match nothing — the
-- whole post-order verification leg (submit proof to verify.et, webhook
-- completes it, Telegram message edited) silently no-opped on staging.
--
-- Fix: the base URL moves into a per-environment vault secret
-- 'functions_base_url' (set at project setup, like verify_function_secret).
-- Resolution order: app.supabase_functions_url setting -> vault secret ->
-- prod fallback (kept so prod behaves identically with zero config change).
--
-- Post-deploy setup per environment:
--   SELECT vault.create_secret('https://<project-ref>.supabase.co/functions/v1',
--                              'functions_base_url');

-- 1. Base-URL reader: vault-only, same lockdown as verify_function_secret ---
CREATE OR REPLACE FUNCTION public.functions_base_url()
RETURNS text AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'functions_base_url'
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.functions_base_url() FROM anon, authenticated, PUBLIC;

-- 2. Rebuild both callers with the vault-backed resolution ------------------
CREATE OR REPLACE FUNCTION public.trigger_verify_order_payment()
RETURNS trigger AS $$
DECLARE
  secret text := public.verify_function_secret();
  fn_url text := COALESCE(
    current_setting('app.supabase_functions_url', true),
    public.functions_base_url(),
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

CREATE OR REPLACE FUNCTION public.request_payment_verification(p_order_id text)
RETURNS void AS $$
DECLARE
  secret text := public.verify_function_secret();
  fn_url text := COALESCE(
    current_setting('app.supabase_functions_url', true),
    public.functions_base_url(),
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

-- Grants/revokes unchanged from 040/058: request_payment_verification stays
-- revoked from anon/authenticated/PUBLIC (internal only).
REVOKE EXECUTE ON FUNCTION public.request_payment_verification(text) FROM anon, authenticated, PUBLIC;

NOTIFY pgrst, 'reload schema';
