-- Timor Shop: per-product visibility toggle — hide from shoppers (075).
-- Run after 074_scoped_payment_verifications_read.sql.
--
-- products.is_hidden lets a shop pull an item from every shopper-facing
-- surface WITHOUT deleting it (past orders, carts and the staff Manage
-- Items list are untouched; staff see the row dimmed with an eye-off
-- toggle). The catalog feed fetch_products_with_shop excludes hidden rows
-- for shoppers — the same place 037's is_active filtering happens — so the
-- exclusion covers the initial fetch AND the realtime refetch (the client
-- re-runs this RPC on any products change). The owning shop's staff and the
-- super admin still receive their hidden rows (their Manage Items lists run
-- off the same context feed); the client additionally filters hidden rows
-- from shopper screens as defense-in-depth (stale AsyncStorage cache), and
-- ProductDetail shows the "not found" state to shoppers.
--
-- Writes need no new gate: hiding is a plain products UPDATE, already
-- restricted to the super admin or the owning shop's staff with the Shop
-- capability (052 policies). Reads are not a security boundary — the
-- products SELECT policy is public (002); hiding is a catalog/UX feature.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;

-- Recreate the catalog RPC with the hidden filter. The OUT row type gains
-- is_hidden (staff clients need the flag to render their Manage Items list
-- dimmed), and Postgres refuses to change a function's OUT row type in
-- place (same pattern as 029/031/035/036/037/043/046) — drop first.
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
  payment_verification_enabled boolean,
  branch_selection_enabled boolean,
  is_hidden boolean
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
    pr.payment_verification_enabled,
    pr.branch_selection_enabled,
    p.is_hidden
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  WHERE pr.is_active IS DISTINCT FROM false
    -- 075: hidden products leave the shopper catalog; the owning shop's
    -- staff and the super admin still receive them (their staff lists run
    -- off this same feed).
    AND (
      NOT p.is_hidden
      OR public.is_super_admin()
      OR p.owner_id = public.effective_tenant_id()
    )
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;

NOTIFY pgrst, 'reload schema';
