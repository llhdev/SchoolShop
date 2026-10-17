-- Timor Shop: per-tenant payment verification switch.
-- Run after 042_verification_toggle.sql.
--
-- The global kill-switch (042) gates the whole pipeline; this adds a
-- per-shop flag so the super admin can require payment verification for one
-- store while another store's orders are placed with proofs only. Effective
-- behavior: a shop's payment is verified iff BOTH
-- platform_settings.payment_verification_enabled (042) AND
-- profiles.payment_verification_enabled (this migration) are on.
--
-- All three verification edge functions read both flags per request; the
-- checkout screen hides the verification step for shops whose flag is off —
-- their orders carry no payment_references for them, and verify-order-payment
-- skips their slice (no verify.et credits burned, no verification messages).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS payment_verification_enabled boolean NOT NULL DEFAULT true;

-- Expose the flag to the checkout screen through the catalog RPC. Drop and
-- recreate because Postgres refuses to change a function's OUT-parameter row
-- type in place (same pattern as 029/031/035/036/037).
DROP FUNCTION IF EXISTS public.fetch_products_with_shop();

CREATE FUNCTION public.fetch_products_with_shop()
RETURNS TABLE (
  id text,
  name text,
  description text,
  price numeric,
  compare_at_price numeric,
  category text,
  images text[],
  detail_images text[],
  cover_image_index integer,
  price_hidden boolean,
  order_count integer,
  created_at timestamptz,
  owner_id uuid,
  shop_name text,
  bank_accounts jsonb,
  shipping_fee numeric,
  shop_logo_url text,
  shop_description text,
  telegram_username text,
  variants jsonb,
  checkout_fields jsonb,
  payment_verification_enabled boolean
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.description,
    p.price,
    p.compare_at_price,
    p.category,
    p.images,
    p.detail_images,
    p.cover_image_index,
    p.price_hidden,
    p.order_count,
    p.created_at,
    p.owner_id,
    pr.shop_name,
    pr.bank_accounts,
    pr.shipping_fee,
    pr.shop_logo_url,
    pr.shop_description,
    pr.telegram_username,
    p.variants,
    p.checkout_fields,
    pr.payment_verification_enabled
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  WHERE pr.is_active IS DISTINCT FROM false
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;

-- Super admin flips a tenant's verification flag. Tenants cannot toggle
-- themselves (role = 'admin' guard), same super-admin check pattern as
-- admin_set_tenant_active (037).
CREATE OR REPLACE FUNCTION public.admin_set_tenant_payment_verification(
  tenant_id uuid,
  new_enabled boolean
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only the super admin can change payment verification settings.';
  END IF;

  UPDATE public.profiles
  SET payment_verification_enabled = new_enabled
  WHERE id = tenant_id AND role = 'admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.admin_set_tenant_payment_verification(uuid, boolean) TO authenticated;
