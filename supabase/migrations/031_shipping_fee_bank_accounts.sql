-- Timor Shop: per-tenant shipping fee + multiple bank accounts.
-- Run after 030_product_order_count.sql.
--
-- 1. Tenants can set a flat shipping fee per shop per order
--    (profiles.shipping_fee, NULL/0 = free) and list more than one bank
--    account (profiles.bank_accounts jsonb), each entry:
--      {"account_number": text, "bank_name": text|null, "qr_image_url": text|null}
-- 2. Checkout stores the per-shop fees charged on the order itself
--    (orders.shipping_fees, same shape as payment_proofs from migration 020)
--    so the historical breakdown survives later tenant edits.
-- 3. The catalog RPC (fetch_products_with_shop) exposes the new fields
--    instead of the retired single-account columns.

-- 1. New profile columns.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS shipping_fee numeric,
  ADD COLUMN IF NOT EXISTS bank_accounts jsonb NOT NULL DEFAULT '[]';

-- Backfill: the existing single account becomes the first list entry.
UPDATE public.profiles
SET bank_accounts = jsonb_build_array(
      jsonb_build_object(
        'account_number', bank_account_number,
        'bank_name', NULL,
        'qr_image_url', bank_qr_image_url
      )
    )
WHERE bank_account_number IS NOT NULL
  AND bank_account_number <> ''
  AND bank_accounts = '[]'::jsonb;

-- 2. Per-shop shipping fees charged at checkout, keyed by tenant owner id
--    (the same owner_id stamped onto order items).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_fees jsonb NOT NULL DEFAULT '{}';

-- 3. Recreate the catalog RPC: bank_account_number / bank_qr_image_url are
--    replaced by bank_accounts + shipping_fee. Postgres refuses to change a
--    function's OUT-parameter row type in place, so drop and recreate.
--    Callers use supabase.rpc('fetch_products_with_shop'), which resolves at
--    call time — no client breakage.
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
    pr.bank_accounts,
    pr.shipping_fee,
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

-- 4. Self-service RPCs for tenant admins (replaces update_own_bank_details
--    from migration 020). SECURITY DEFINER because profiles UPDATE policies
--    only cover the super admin; only the caller's own row is touched.
--    The jsonb array is normalized: entries missing account_number are
--    dropped, empty bank names become NULL.
CREATE OR REPLACE FUNCTION public.update_own_bank_accounts(p_accounts jsonb)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET bank_accounts = COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'account_number', trim(elem->>'account_number'),
                   'bank_name', NULLIF(trim(elem->>'bank_name'), ''),
                   'qr_image_url', NULLIF(trim(elem->>'qr_image_url'), '')
                 )
               )
        FROM jsonb_array_elements(COALESCE(p_accounts, '[]'::jsonb)) AS elem
        WHERE NULLIF(trim(elem->>'account_number'), '') IS NOT NULL
      ), '[]'::jsonb)
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_own_shipping_fee(p_fee numeric)
RETURNS void AS $$
BEGIN
  IF p_fee IS NOT NULL AND p_fee < 0 THEN
    RAISE EXCEPTION 'Shipping fee cannot be negative.';
  END IF;

  UPDATE public.profiles
  SET shipping_fee = CASE WHEN p_fee IS NULL OR p_fee <= 0 THEN NULL ELSE p_fee END
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.update_own_bank_accounts(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_own_shipping_fee(numeric) TO authenticated;
