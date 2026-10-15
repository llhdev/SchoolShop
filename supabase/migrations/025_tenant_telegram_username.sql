-- Timor Shop tenant Telegram usernames migration
-- Run after 024_tenant_shop_description.sql.
--
-- Each tenant shop can publish a Telegram username (profiles.telegram_username)
-- that shoppers use to reach the shop directly: a chat icon on the product
-- detail page and per line item on the order detail page opens
-- https://t.me/<username>. The super admin sets it when creating/editing a
-- tenant; a tenant can also edit their own via the
-- update_own_telegram_username RPC (profiles UPDATE policies only cover the
-- super admin, hence the SECURITY DEFINER — same pattern as 024's
-- update_own_shop_description). The username flows to shoppers through the
-- catalog RPC, since profiles is not anon-readable. Orders stamp each item's
-- product snapshot with the owner's username at insert time (same trigger that
-- stamps owner_id/shop_name), so old orders keep their link even if the tenant
-- later changes the username.

-- 1. Username column on tenant profiles.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS telegram_username text;

-- 2. Self-service: a tenant admin edits their own shop Telegram username.
CREATE OR REPLACE FUNCTION public.update_own_telegram_username(
  p_username text
)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET telegram_username = nullif(trim(both '@' from trim(p_username)), '')
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.update_own_telegram_username(text) TO authenticated;

-- 3. Extend the catalog RPC with the owner's Telegram username. Postgres
--    refuses to change a function's OUT-parameter row type in place, so drop
--    and recreate. Callers use supabase.rpc('fetch_products_with_shop'), which
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
    p.cover_image_index,
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

-- 4. Stamp each order item's product snapshot with the owner's Telegram
--    username, alongside the owner_id/shop_name stamping from 018/019. The
--    018 trigger binding is untouched.
CREATE OR REPLACE FUNCTION public.stamp_order_tenants()
RETURNS trigger AS $$
BEGIN
  NEW.tenant_ids := COALESCE((
    SELECT array_agg(DISTINCT p.owner_id)
    FROM public.products p
    WHERE p.owner_id IS NOT NULL
      AND p.id IN (
        SELECT elem->'product'->>'id'
        FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
        WHERE elem->'product'->>'id' IS NOT NULL
      )
  ), '{}');

  NEW.items := COALESCE((
    SELECT jsonb_agg(
      CASE
        WHEN elem->'product'->>'id' IS NULL THEN elem
        ELSE jsonb_set(
               jsonb_set(
                 jsonb_set(elem, '{product,owner_id}',
                   to_jsonb(COALESCE(p.owner_id::text, ''))),
                 '{product,shop_name}',
                 to_jsonb(COALESCE(pr.shop_name, ''))
               ),
               '{product,telegram_username}',
               to_jsonb(COALESCE(pr.telegram_username, ''))
             )
      END
    )
    FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
    LEFT JOIN public.products p ON p.id = elem->'product'->>'id'
    LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  ), '[]'::jsonb);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
