-- Timor Shop: expose the tenant shop name on each product.
-- Run this in the Supabase SQL Editor after 016_restore_shopper_order_read.sql.
--
-- The profiles table (which holds shop_name) is not readable by anon, so the
-- app cannot join products -> profiles from the shopper client. This SECURITY
-- DEFINER RPC returns the product catalog with the owner's shop_name attached,
-- following the same pattern as get_admin_by_username (004). Products are
-- already publicly readable and shop names are intended to be public.

CREATE OR REPLACE FUNCTION public.fetch_products_with_shop()
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
  shop_name text
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
    pr.shop_name
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Allow anonymous and authenticated users to call the catalog lookup.
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
