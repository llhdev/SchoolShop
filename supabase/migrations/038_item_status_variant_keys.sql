-- Timor Shop: fix per-item status updates for items with variants (035).
-- Run after 037_shop_active_switch.sql.
--
-- update_order_item_status (022) validated p_item_key against the legacy
-- "productId:selectedImageIndex" format. Since variants (035) the client keys
-- lines as "productId:selectedImageIndex:Group=Option|…" (see getCartItemLineId
-- in src/utils/variants.ts), so every status change on a variant item raised
-- "Item not found in this order, or not owned by you." and the client rolled
-- back — tenants could not change item statuses at all. Recompute the same
-- key server-side; selectedOptions array order is preserved via WITH ORDINALITY,
-- matching the client's variantKeyOf. Items without options keep the legacy
-- key, so orders written before 035 are unaffected.

CREATE OR REPLACE FUNCTION public.update_order_item_status(
  p_order_id text,
  p_item_key text,
  p_status text
)
RETURNS void AS $$
DECLARE
  o public.orders%ROWTYPE;
  item_key text;
BEGIN
  IF p_status NOT IN ('pending', 'paid', 'on_the_way', 'completed') THEN
    RAISE EXCEPTION 'Invalid item status: %', p_status;
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF NOT public.is_super_admin()
     AND NOT (o.tenant_ids @> ARRAY[auth.uid()]::uuid[]) THEN
    RAISE EXCEPTION 'Only the super admin or a tenant in this order can update item statuses.';
  END IF;

  -- The key must match a real line item of the order, computed exactly the
  -- way the client builds it (getCartItemLineId): base "productId:imageIndex"
  -- plus ":Group=Option|…" when the line has variant selections. For
  -- non-super-admins the item must belong to them (server-stamped owner_id,
  -- camelCase fallback).
  SELECT keyed.key INTO item_key
  FROM (
    SELECT
      it,
      it->'product'->>'id' || ':' || COALESCE(it->>'selectedImageIndex', '0') ||
      CASE
        WHEN jsonb_array_length(COALESCE(it->'selectedOptions', '[]'::jsonb)) > 0
        THEN ':' || (
          SELECT string_agg((opt->>'group') || '=' || (opt->>'option'), '|' ORDER BY ord)
          FROM jsonb_array_elements(it->'selectedOptions') WITH ORDINALITY AS t(opt, ord)
        )
        ELSE ''
      END AS key
    FROM jsonb_array_elements(o.items) AS it
  ) AS keyed
  WHERE keyed.key = p_item_key
    AND (
      public.is_super_admin()
      OR keyed.it->'product'->>'owner_id' = auth.uid()::text
      OR keyed.it->'product'->>'ownerId' = auth.uid()::text
    )
  LIMIT 1;

  IF item_key IS NULL THEN
    RAISE EXCEPTION 'Item not found in this order, or not owned by you.';
  END IF;

  UPDATE public.orders
  SET item_statuses = jsonb_set(item_statuses, ARRAY[p_item_key], to_jsonb(p_status), true)
  WHERE id = p_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.update_order_item_status(text, text, text) TO authenticated;
