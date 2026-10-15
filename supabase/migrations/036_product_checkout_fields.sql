-- Timor Shop: tenant-defined checkout questions per product.
-- Tenants can attach extra questions ("Campus branch", "ID number", "Name")
-- to a product; the buyer answers them at checkout. Stored as jsonb:
--   [{"label":"Campus branch","type":"dropdown","required":true,
--     "options":["Main","Science"]},
--    {"label":"ID number","type":"text","required":true}]
-- NULL/[] = no questions, checkout shows only the fixed fields (phone,
-- optional location, payment proof). Answers are stored on the order item
-- snapshot (orders.items[].fieldAnswers), so orders need no new column.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS checkout_fields jsonb;

-- The catalog RPC returns a fixed column list — the new column must be added
-- there too, otherwise refetched products silently lose their questions.
-- Postgres refuses to change a function's OUT-parameter row type in place,
-- so drop and recreate (same pattern as migrations 029/031/035).
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
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
