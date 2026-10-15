-- Timor Shop: product variant groups.
-- Tenants can attach named option groups ("Size", "Color") to a product; one
-- group sets the price (its options carry their own prices) and any option
-- can point at one of the product's existing images. Stored as jsonb:
--   [{"name":"Size","affects_price":false,"options":[{"name":"42-43"}]},
--    {"name":"Color","affects_price":true,
--     "options":[{"name":"Black","price":500,"image_index":0}]}]
-- NULL/[] = no variants, the product behaves as before.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS variants jsonb;

-- The catalog RPC returns a fixed column list — the new column must be added
-- there too, otherwise refetched products silently lose their variants.
-- Postgres refuses to change a function's OUT-parameter row type in place,
-- so drop and recreate (same pattern as migrations 029/031).
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
  variants jsonb
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
    p.variants
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
