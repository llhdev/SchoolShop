-- Timor Shop: real popularity — products.order_count
-- Counts how many units of each product have been ordered (sum of quantities
-- across all orders), incremented server-side by a trigger so counts are
-- honest regardless of client. Starts at 0 for existing products.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS order_count integer NOT NULL DEFAULT 0;

-- Bump the counter whenever an order is placed. items is jsonb array of
-- CartItem: { product: { id }, quantity, selectedImageIndex }.
CREATE OR REPLACE FUNCTION public.increment_product_order_counts()
RETURNS trigger AS $$
BEGIN
  WITH line_items AS (
    SELECT
      (item -> 'product' ->> 'id') AS product_id,
      COALESCE((item ->> 'quantity')::integer, 1) AS qty
    FROM jsonb_array_elements(NEW.items) AS item
  )
  UPDATE public.products p
  SET order_count = p.order_count + c.total_qty
  FROM (
    SELECT product_id, SUM(qty) AS total_qty
    FROM line_items
    WHERE product_id IS NOT NULL
    GROUP BY product_id
  ) c
  WHERE p.id = c.product_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_order_created_increment_counts ON public.orders;
CREATE TRIGGER on_order_created_increment_counts
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.increment_product_order_counts();

-- The catalog RPC returns a fixed column list — order_count must be added
-- there too, otherwise refetched products silently lose the count.
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
    p.order_count,
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
