-- Timor Shop per-item order statuses migration
-- Run after 021_product_bank_details.sql.
--
-- Order-level status stays as the fallback label, but each line item inside an
-- order can now carry its own status (pending/paid/on_the_way/completed) so a
-- shopper can track items from one checkout independently. Statuses are keyed
-- by "productId:selectedImageIndex", which is unique within an order because
-- the cart merges duplicate product+image selections into one line.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS item_statuses jsonb NOT NULL DEFAULT '{}';

-- Per-item status update. SECURITY DEFINER because RLS alone cannot express
-- "this admin may touch only the items whose stamped owner_id is them".
-- Super admin: any item of any order. Tenant admin: any item they own in an
-- order whose tenant_ids include them.
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

  -- The key must match a real line item of the order. For non-super-admins the
  -- item must belong to them (server-stamped owner_id, camelCase fallback).
  SELECT it->'product'->>'id' || ':' || COALESCE(it->>'selectedImageIndex', '0')
    INTO item_key
  FROM jsonb_array_elements(o.items) AS it
  WHERE it->'product'->>'id' || ':' || COALESCE(it->>'selectedImageIndex', '0') = p_item_key
    AND (
      public.is_super_admin()
      OR it->'product'->>'owner_id' = auth.uid()::text
      OR it->'product'->>'ownerId' = auth.uid()::text
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
