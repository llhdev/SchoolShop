-- Timor Shop: scoped order reads (062).
-- Run after 061_rate_limits.sql.
--
-- 016 restored a world-readable orders table ("Allow public read orders",
-- SELECT TO anon, authenticated USING true) so shopper order history and
-- realtime worked. That made every customer's phone number, location and
-- payment proof public API data. This migration replaces the open read with
-- three scoped paths:
--   1. admins keep reading via a tenant-scoped SELECT policy (authenticated);
--   2. guests re-fetch the orders their device placed via
--      get_order_for_shopper(order id + phone — the phone the shopper typed
--      at checkout is the capability, the order id alone no longer suffices);
--   3. Mini App shoppers fetch their history via get_orders_by_telegram_id
--      with an HMAC token issued by the telegram-auth edge function after
--      initData validation (token = HMAC_SHA256(telegram_id, vault secret)).
-- attach_order_telegram_id also gains the phone check: the old (text, bigint)
-- form let anyone bind a telegram_id to any order by id.
--
-- Side effect: anonymous clients no longer satisfy realtime's SELECT
-- requirement on orders, so guest/shopper live updates stop arriving; the
-- client still refetches on launch and after checkout, and admins (all
-- authenticated) keep their realtime stream.

-- ---------------------------------------------------------------------------
-- 1. Drop the world-readable policy; admins read scoped rows only. Same
--    tenant_ids membership test as the UPDATE policy (migration 020), with
--    effective_tenant_id() (045) so staff accounts read their parent shop's
--    orders. Anonymous SELECT now returns zero rows.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow public read orders" ON public.orders;

CREATE POLICY "Admins read scoped orders"
  ON public.orders FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR tenant_ids @> ARRAY[public.effective_tenant_id()]::uuid[]
  );

-- ---------------------------------------------------------------------------
-- 2. get_order_for_shopper: a guest's device-local history refetch. Returns
--    the order only when the caller also knows the phone number typed at
--    checkout (non-empty, trimmed compare). Empty phone never matches, so
--    legacy rows with a blank phone are not retrievable this way.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_for_shopper(
  p_order_id text,
  p_phone text
)
RETURNS SETOF public.orders AS $$
  SELECT * FROM public.orders
  WHERE id = p_order_id
    AND phone_number <> ''
    AND phone_number = trim(p_phone);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_order_for_shopper(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_order_for_shopper(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. get_orders_by_telegram_id: Mini App order history. The token is
--    HMAC-SHA256 hex of the telegram id keyed by the shared vault secret
--    (040's verify_function_secret), issued by telegram-auth only after the
--    signed initData checks out — so a telegram id alone no longer lists
--    orders. Token mismatch (or missing secret) returns empty rather than an
--    error: the client treats both as "no history yet" and re-authenticates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_orders_by_telegram_id(
  p_telegram_id bigint,
  p_token text
)
RETURNS SETOF public.orders AS $$
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
    SELECT * FROM public.orders
    WHERE telegram_id = p_telegram_id
    ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;

GRANT EXECUTE ON FUNCTION public.get_orders_by_telegram_id(bigint, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_orders_by_telegram_id(bigint, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. attach_order_telegram_id now requires the order's phone number, like
--    get_order_for_shopper: knowing an order id no longer lets anyone bind
--    their telegram_id to it (which would have leaked the order into their
--    Mini App history). Still only fills a NULL telegram_id — never
--    overwrites. The old 2-argument form is dropped outright.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attach_order_telegram_id(text, bigint);

CREATE OR REPLACE FUNCTION public.attach_order_telegram_id(
  p_order_id text,
  p_telegram_id bigint,
  p_phone text
)
RETURNS void AS $$
BEGIN
  UPDATE public.orders
  SET telegram_id = p_telegram_id
  WHERE id = p_order_id
    AND telegram_id IS NULL
    AND phone_number <> ''
    AND phone_number = trim(p_phone);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.attach_order_telegram_id(text, bigint, text) TO anon;
GRANT EXECUTE ON FUNCTION public.attach_order_telegram_id(text, bigint, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
