-- Timor Shop: "price on request" products
-- Tenants can post special items (ID cards, custom orders) with no price:
-- shoppers see no price tag and can only chat with the shop to order.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS price_hidden boolean NOT NULL DEFAULT false;

-- The catalog RPC returns a fixed column list — the new column must be added
-- there too, otherwise refetched products silently lose the flag.
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
  created_at timestamptz,
  owner_id uuid,
  shop_name text,
  bank_account_number text,
  bank_qr_image_url text,
  shop_logo_url text,
  shop_description text,
  telegram_username text
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
    p.created_at,
    p.owner_id,
    pr.shop_name,
    pr.bank_account_number,
    pr.bank_qr_image_url,
    pr.shop_logo_url,
    pr.shop_description,
    pr.telegram_username
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
