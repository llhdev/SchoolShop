-- Timor Shop: expose tenant bank transfer details on each product.
-- Run after 020_bank_transfer.sql.
--
-- Checkout needs the tenant's bank account number and QR code so the shopper
-- knows where to transfer money. profiles is not anon-readable, so this
-- extends the SECURITY DEFINER catalog RPC (017) with the two bank columns
-- from the owner's profile. Bank details are intentionally public — shoppers
-- need them to pay, and the Telegram bot needs nothing extra.

-- Postgres refuses to change a function's OUT-parameter row type in place, so
-- drop and recreate. Callers use supabase.rpc('fetch_products_with_shop'),
-- which resolves at call time — no client breakage.
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
  bank_qr_image_url text
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
    pr.bank_qr_image_url
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CREATE OR REPLACE preserves the existing grants from 017; restate them so
-- the migration is self-contained if replayed on a fresh project.
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
