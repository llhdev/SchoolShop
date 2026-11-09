-- Timor Shop: branches are derived from branch-admin staff accounts, and the
-- per-shop branch dropdown at checkout is tenant-controlled.
-- Run after 045_staff_roles_branches.sql.
--
-- 045 introduced a standalone branches editor; 046 removes that concept from
-- the app: a branch exists exactly because a Branch Admin staff account
-- exists (branch name = the account's label), created/renamed/deleted with
-- the staff account. profiles.branch_selection_enabled lets each shop decide
-- whether shoppers pick a branch at checkout (off = no dropdown, orders
-- arrive unstamped, branch staff see the whole shop).

-- 1. Per-shop branch-selection toggle ----------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS branch_selection_enabled boolean NOT NULL DEFAULT true;

-- 2. Same-shop profile reads ---------------------------------------------------
--
-- Staff could previously read only their own profile row, so the parent
-- shop's is_active / branch_selection_enabled checks were silently skipped
-- for them. Let every account read the rows of its own shop (owner + staff).
CREATE POLICY "Allow staff read shop profiles" ON public.profiles
  FOR SELECT USING (
    id = public.effective_tenant_id()
    OR parent_tenant_id = public.effective_tenant_id()
  );

-- 3. Expose the toggle to anonymous checkout ------------------------------------
--
-- Drop/recreate because Postgres refuses to change a function's OUT-parameter
-- row type in place (same pattern as 029/031/035/036/037/043).
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
  branch_selection_enabled boolean
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
    pr.branch_selection_enabled
  FROM public.products p
  LEFT JOIN public.profiles pr ON pr.id = p.owner_id
  WHERE pr.is_active IS DISTINCT FROM false
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_products_with_shop() TO authenticated;
