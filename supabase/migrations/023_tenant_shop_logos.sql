-- Timor Shop tenant shop logos migration
-- Run after 022_item_statuses.sql.
--
-- Every tenant shop gets a logo (profiles.shop_logo_url), set by the super
-- admin at tenant creation (mandatory) and editable only by the super admin.
-- The logo is shown in the shopper-facing Store filter, so it must be
-- readable by anon clients: profiles is not anon-readable, hence the
-- shop-logos storage bucket (public read) and the extended catalog RPC
-- (fetch_products_with_shop now also returns the owner's logo).

-- 1. Logo column on tenant profiles.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS shop_logo_url text;

-- 2. Storage bucket for shop logos. Public read so shoppers can see them;
--    insert/delete follow the MVP's public pattern used for bank-qrs (020).
--    Logos are display-only images (no QR scannability concern), so the app
--    resizes them before upload.
INSERT INTO storage.buckets (id, name, public)
VALUES ('shop-logos', 'shop-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Allow public upload shop logos" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'shop-logos');
CREATE POLICY "Allow public read shop logos" ON storage.objects
  FOR SELECT USING (bucket_id = 'shop-logos');
CREATE POLICY "Allow public delete shop logos" ON storage.objects
  FOR DELETE USING (bucket_id = 'shop-logos');

-- 3. Extend the catalog RPC with the owner's logo. Postgres refuses to
--    change a function's OUT-parameter row type in place, so drop and
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
  shop_logo_url text
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
    pr.shop_logo_url
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
