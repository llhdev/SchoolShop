-- Timor Shop tenant shop descriptions migration
-- Run after 023_tenant_shop_logos.sql.
--
-- Each tenant shop carries a short description (profiles.shop_description)
-- shown to shoppers in the Store filter list. The super admin sets it when
-- creating/editing a tenant; a tenant can also edit their own via the
-- update_own_shop_description RPC (profiles UPDATE policies only cover the
-- super admin, hence the SECURITY DEFINER — same pattern as 020's
-- update_own_bank_details). The description flows to shoppers through the
-- catalog RPC, since profiles is not anon-readable.

-- 1. Description column on tenant profiles.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS shop_description text;

-- 2. Self-service: a tenant admin edits their own shop description.
CREATE OR REPLACE FUNCTION public.update_own_shop_description(
  p_description text
)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET shop_description = nullif(trim(p_description), '')
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.update_own_shop_description(text) TO authenticated;

-- 3. Extend the catalog RPC with the owner's description. Postgres refuses
--    to change a function's OUT-parameter row type in place, so drop and
--    recreate. Callers use supabase.rpc('fetch_products_with_shop'), which
--    resolves at call time — no client breakage.
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
  cover_image_index integer,
  created_at timestamptz,
  owner_id uuid,
  shop_name text,
  bank_account_number text,
  bank_qr_image_url text,
  shop_logo_url text,
  shop_description text
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
    p.cover_image_index,
    p.created_at,
    p.owner_id,
    pr.shop_name,
    pr.bank_account_number,
    pr.bank_qr_image_url,
    pr.shop_logo_url,
    pr.shop_description
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
