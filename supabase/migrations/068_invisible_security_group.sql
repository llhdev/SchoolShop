-- Timor Shop: invisible security group (068).
-- Run after 067_claim_on_paid_and_manual_reference.sql.
--
-- Audit follow-ups that close residual exposure without changing any user or
-- admin behavior:
--   1. The legacy `payment-proofs` storage bucket is still public = true.
--      060 dropped its RLS policies, but PUBLIC buckets serve objects via
--      /object/public/... URLs that bypass storage RLS entirely, so legacy
--      proof screenshots stayed world-readable by URL. Flip the bucket to
--      private. (Objects themselves should still be copied to R2 and deleted
--      via migrate-proofs-to-r2.js — this stops new public-URL reads.)
--   2. get_order_for_shopper / get_orders_by_telegram_id returned SETOF
--      orders — the entire row, including payment_references, payment_proofs,
--      payment_warnings and the server-only telegram_notifications — to any
--      capability holder (order id + phone, or an HMAC ordersToken). They now
--      return a safe projection. The shopper UI never renders those fields
--      (proofs are canSeeProofs-gated, references/warnings are staff-only in
--      OrderDetailScreen), so nothing visible changes.
--   3. "Allow super admin update profiles" (003) had USING but no WITH CHECK;
--      recreated with both for consistency with the 052-era policies.

-- ---------------------------------------------------------------------------
-- 1. Legacy proofs bucket: private. Reads now require a signed URL (service
--    role / sign-proof-get fallback), writes were already locked down in 060.
-- ---------------------------------------------------------------------------
UPDATE storage.buckets SET public = false WHERE id = 'payment-proofs';

-- ---------------------------------------------------------------------------
-- 2a. get_order_for_shopper: same capability (order id + checkout phone),
--     safe column list. Return type changes, so drop + recreate (grants are
--     re-applied below).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_order_for_shopper(text, text);

CREATE FUNCTION public.get_order_for_shopper(
  p_order_id text,
  p_phone text
)
RETURNS TABLE (
  id text,
  items jsonb,
  total numeric,
  payment_method text,
  status text,
  location text,
  phone_number text,
  student_name text,
  created_at timestamptz,
  telegram_id bigint,
  tenant_ids uuid[],
  shipping_fees jsonb,
  item_statuses jsonb
) AS $$
  SELECT o.id, o.items, o.total, o.payment_method, o.status, o.location,
         o.phone_number, o.student_name, o.created_at, o.telegram_id,
         o.tenant_ids, o.shipping_fees, o.item_statuses
  FROM public.orders o
  WHERE o.id = p_order_id
    AND o.phone_number <> ''
    AND o.phone_number = trim(p_phone);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_order_for_shopper(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_order_for_shopper(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2b. get_orders_by_telegram_id: same HMAC token gate as 062, same safe
--     projection.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_orders_by_telegram_id(bigint, text);

CREATE FUNCTION public.get_orders_by_telegram_id(
  p_telegram_id bigint,
  p_token text
)
RETURNS TABLE (
  id text,
  items jsonb,
  total numeric,
  payment_method text,
  status text,
  location text,
  phone_number text,
  student_name text,
  created_at timestamptz,
  telegram_id bigint,
  tenant_ids uuid[],
  shipping_fees jsonb,
  item_statuses jsonb
) AS $$
DECLARE
  v_secret text := public.verify_function_secret();
BEGIN
  IF v_secret IS NULL OR v_secret = '' OR p_token IS NULL OR p_token = '' THEN
    RETURN;
  END IF;
  IF encode(hmac(p_telegram_id::text, v_secret, 'sha256'), 'hex') <> p_token THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT o.id, o.items, o.total, o.payment_method, o.status, o.location,
           o.phone_number, o.student_name, o.created_at, o.telegram_id,
           o.tenant_ids, o.shipping_fees, o.item_statuses
    FROM public.orders o
    WHERE o.telegram_id = p_telegram_id
    ORDER BY o.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;

GRANT EXECUTE ON FUNCTION public.get_orders_by_telegram_id(bigint, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_orders_by_telegram_id(bigint, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. profiles super-admin UPDATE policy: add the missing WITH CHECK.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow super admin update profiles" ON public.profiles;

CREATE POLICY "Allow super admin update profiles" ON public.profiles
  FOR UPDATE
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

NOTIFY pgrst, 'reload schema';
