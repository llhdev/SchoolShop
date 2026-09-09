-- Timor Shop order Telegram backfill migration
-- Run this in the Supabase SQL Editor after 014_tenant_codes.sql.
-- A shopper's order history is keyed by orders.telegram_id. An order placed
-- before the Mini App's initData validation finishes is saved with
-- telegram_id NULL, and the client cannot backfill it because the UPDATE
-- policy (012) is super-admin only. This RPC lets a client claim its own
-- just-placed orders by stamping the (still NULL) telegram_id.
-- No role check: orders are already publicly insertable in this MVP and the
-- order id is an unguessable 8-char code, so this adds no practical attack
-- surface. It can only fill a NULL column, never overwrite a value.
CREATE OR REPLACE FUNCTION public.attach_order_telegram_id(
  p_order_id text,
  p_telegram_id bigint
)
RETURNS void AS $$
BEGIN
  UPDATE public.orders
  SET telegram_id = p_telegram_id
  WHERE id = p_order_id AND telegram_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.attach_order_telegram_id(text, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.attach_order_telegram_id(text, bigint) TO authenticated;
