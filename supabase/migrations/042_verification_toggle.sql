-- Timor Shop: runtime kill-switch for payment verification.
-- Run after 041_payment_references.sql.
--
-- Replaces the hardcoded VERIFICATION_PAUSED constant in the three
-- verification edge functions with a DB flag the super admin can flip at
-- runtime (SQL editor or the admin UI switch) — no redeploy needed:
--
--   UPDATE platform_settings SET value = 'false'
--   WHERE key = 'payment_verification_enabled';
--
-- When disabled: the pre-order verify-payment-reference check returns
-- 'unavailable' (the checkout screen hides the verification step entirely
-- and Place Order works with proofs only, like pre-040), the order-time
-- verify-order-payment skips verify.et submissions (no credits burned, no
-- Telegram verification messages), and the webhook acknowledges without
-- completing. telegram-order-notify (order summary + proof photo) is NOT
-- affected — only the verification pipeline stops.

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Anyone may read the flag (the checkout screen needs it to decide whether
-- to require verification); only the super admin may change it.
CREATE POLICY "Public read platform settings"
  ON public.platform_settings FOR SELECT USING (true);

CREATE POLICY "Super admin upsert platform settings"
  ON public.platform_settings FOR INSERT
  WITH CHECK (public.is_super_admin());

CREATE POLICY "Super admin update platform settings"
  ON public.platform_settings FOR UPDATE
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- Seeded ENABLED. Note: until the new checkout web build is deployed, orders
-- placed by the old build carry no payment_references and fall back to the
-- image-based verify.et path, burning one image credit per proof.
INSERT INTO public.platform_settings (key, value)
VALUES ('payment_verification_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
