-- Timor Shop: super admin can switch a shop off/on.
-- While a tenant's profile is_active = false:
--   * fetch_products_with_shop() hides all of their products from the
--     catalog (grid, search, Store filter — everything derives from this RPC)
--   * the client refuses their login and signs out an active session
-- Switching back on restores everything; nothing is deleted.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Catalog filter: drop/recreate because Postgres refuses to change a
-- function's OUT-parameter row type in place (same pattern as 029/031/035/036).
-- IS DISTINCT FROM false keeps both active tenants and NULL-owner products.
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
  checkout_fields jsonb
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
    p.checkout_fields
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  WHERE pr.is_active IS DISTINCT FROM false
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;

-- Super admin flips a tenant's active flag. Tenants cannot toggle themselves
-- or the super admin (role = 'admin' guard), same super-admin check pattern
-- as admin_update_tenant (013).
CREATE OR REPLACE FUNCTION public.admin_set_tenant_active(
  tenant_id uuid,
  new_is_active boolean
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only the super admin can switch shops on or off.';
  END IF;

  UPDATE public.profiles
  SET is_active = new_is_active
  WHERE id = tenant_id AND role = 'admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.admin_set_tenant_active(uuid, boolean) TO authenticated;
