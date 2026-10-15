-- Timor Shop: order-level status follows per-item statuses.
-- Run after 038_item_status_variant_keys.sql.
--
-- Since per-item statuses (022), update_order_item_status only wrote the
-- item_statuses jsonb — the order-level status column stayed 'pending'
-- forever. Everywhere that reads orders.status (order detail header badge,
-- admin order list badges, status counts/filters) therefore showed a stale
-- "Pending" even after every item moved on. Now the RPC recomputes the
-- order-level status as the LEAST-advanced status across the order's items
-- (an order is only 'completed' when every item is, and stays 'pending'
-- while any item is), and a one-time backfill below repairs existing orders.
--
-- Item keys are computed exactly like the client (038): base
-- "productId:imageIndex" plus ":Group=Option|…" for variant selections.

CREATE OR REPLACE FUNCTION public.update_order_item_status(
  p_order_id text,
  p_item_key text,
  p_status text
)
RETURNS void AS $$
DECLARE
  o public.orders%ROWTYPE;
  item_key text;
  min_ord integer;
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
  WHERE id = p_order_id
  RETURNING * INTO o;

  -- Recompute the order-level status as the least-advanced item status so
  -- order-level badges, counts and filters follow per-item changes. Items
  -- without an explicit entry keep the previous order-level status (the
  -- client's getItemStatus fallback). o.status here is still the OLD value —
  -- the update above only touched item_statuses.
  SELECT MIN(ARRAY_POSITION(
           ARRAY['pending', 'paid', 'on_the_way', 'completed'],
           COALESCE(o.item_statuses ->> keyed.key, o.status)))
  INTO min_ord
  FROM (
    SELECT
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
  ) AS keyed;

  IF min_ord IS NOT NULL THEN
    UPDATE public.orders
    SET status = (ARRAY['pending', 'paid', 'on_the_way', 'completed'])[min_ord]
    WHERE id = p_order_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.update_order_item_status(text, text, text) TO authenticated;

-- One-time backfill: orders whose item statuses were set before this fix
-- have a stale order-level status. Recompute it with the same rule.
WITH keyed AS (
  SELECT
    o.id,
    o.status AS order_status,
    o.item_statuses,
    it->'product'->>'id' || ':' || COALESCE(it->>'selectedImageIndex', '0') ||
    CASE
      WHEN jsonb_array_length(COALESCE(it->'selectedOptions', '[]'::jsonb)) > 0
      THEN ':' || (
        SELECT string_agg((opt->>'group') || '=' || (opt->>'option'), '|' ORDER BY ord)
        FROM jsonb_array_elements(it->'selectedOptions') WITH ORDINALITY AS t(opt, ord)
      )
      ELSE ''
    END AS key
  FROM public.orders AS o,
       jsonb_array_elements(o.items) AS it
  WHERE o.item_statuses <> '{}'::jsonb
),
effective AS (
  SELECT
    id,
    MIN(ARRAY_POSITION(
      ARRAY['pending', 'paid', 'on_the_way', 'completed'],
      COALESCE(item_statuses ->> key, order_status))) AS min_ord
  FROM keyed
  GROUP BY id
)
UPDATE public.orders AS o
SET status = (ARRAY['pending', 'paid', 'on_the_way', 'completed'])[effective.min_ord]
FROM effective
WHERE o.id = effective.id
  AND effective.min_ord IS NOT NULL
  AND o.status <> (ARRAY['pending', 'paid', 'on_the_way', 'completed'])[effective.min_ord];
