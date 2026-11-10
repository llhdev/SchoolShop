-- Timor Shop: unstamped order items are visible/actionable by all of a shop's
-- branch staff (053). Run after 052_staff_permission_fixes.sql.
--
-- Orders placed before a shop created its first branch admin (or while its
-- branch-selection switch was off) carry no branchId stamp. With
-- branch_selection_enabled on, 047's branch scoping hid those items from
-- every branch admin — they were stranded for the branch step of the
-- pipeline (pending -> received). Since the checkout dropdown is required
-- whenever it is visible, unstamped items can only be legacy/pre-branch data,
-- so they are treated as shop-wide: any branch admin of the shop may act on
-- them. Stamped items stay strictly scoped to their branch.
--
-- Client mirror: getOrderItemsForScope in src/services/orders.ts.

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
  v_parent uuid;
  v_tenant uuid;
  v_can_financial boolean;
  v_can_branch boolean;
  v_branch uuid;
  v_branch_selection boolean;
  v_shop_active boolean;
  v_current text;
BEGIN
  IF p_status NOT IN ('pending', 'received', 'paid', 'on_the_way', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid item status: %', p_status;
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  SELECT p.parent_tenant_id, p.staff_financial, p.staff_branch, p.branch_id
  INTO v_parent, v_can_financial, v_can_branch, v_branch
  FROM public.profiles p
  WHERE p.id = auth.uid();
  v_tenant := COALESCE(v_parent, auth.uid());

  -- The shop's checkout branch-selection toggle (046): off = items carry no
  -- branch stamp, so branch scoping does not apply.
  SELECT COALESCE(p.branch_selection_enabled, true), COALESCE(p.is_active, true)
  INTO v_branch_selection, v_shop_active
  FROM public.profiles p
  WHERE p.id = v_tenant;

  IF NOT public.is_super_admin() THEN
    IF NOT v_shop_active THEN
      RAISE EXCEPTION 'This shop is deactivated.';
    END IF;
    IF NOT (o.tenant_ids @> ARRAY[v_tenant]::uuid[]) THEN
      RAISE EXCEPTION 'Only the super admin or a tenant in this order can update item statuses.';
    END IF;
    IF p_status = 'paid' AND NOT COALESCE(v_can_financial, false) THEN
      RAISE EXCEPTION 'Only the financial admin can mark orders paid.';
    END IF;
    IF p_status IN ('received', 'on_the_way', 'completed', 'cancelled')
       AND NOT COALESCE(v_can_branch, false) THEN
      RAISE EXCEPTION 'Only the branch admin can set this status.';
    END IF;
  END IF;

  -- The key must match a real line item of the order, computed exactly the
  -- way the client builds it (getCartItemLineId): base "productId:imageIndex"
  -- plus ":Group=Option|…" when the line has variant selections. For
  -- non-super-admins the item must belong to their effective tenant
  -- (server-stamped owner_id, camelCase fallback). Branch scoping (047) only
  -- applies to items stamped with a branch; unstamped items (053 — orders
  -- from before the shop had branches) are shop-wide for branch staff.
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
      OR (
        (keyed.it->'product'->>'owner_id' = v_tenant::text
         OR keyed.it->'product'->>'ownerId' = v_tenant::text)
        AND (
          v_branch IS NULL
          OR NOT COALESCE(v_branch_selection, true)
          OR keyed.it->>'branchId' = v_branch::text
          OR keyed.it->>'branchId' IS NULL
        )
      )
    )
  LIMIT 1;

  IF item_key IS NULL THEN
    RAISE EXCEPTION 'Item not found in this order, or not owned by you.';
  END IF;

  -- Forward-only transitions for shop staff (super admin can correct freely).
  v_current := COALESCE(o.item_statuses ->> p_item_key, o.status);
  IF NOT public.is_super_admin() AND NOT (
    (v_current = 'pending'    AND p_status IN ('received', 'cancelled')) OR
    (v_current = 'received'   AND p_status IN ('paid', 'cancelled')) OR
    (v_current = 'paid'       AND p_status = 'on_the_way') OR
    (v_current = 'on_the_way' AND p_status = 'completed')
  ) THEN
    RAISE EXCEPTION 'Invalid status change from % to %.', v_current, p_status;
  END IF;

  UPDATE public.orders
  SET item_statuses = jsonb_set(item_statuses, ARRAY[p_item_key], to_jsonb(p_status), true)
  WHERE id = p_order_id
  RETURNING * INTO o;

  -- Recompute the order-level status as the least-advanced NON-cancelled item
  -- status; if every item is cancelled the order is cancelled. Items without
  -- an explicit entry keep the previous order-level status. o.status here is
  -- still the OLD value — the update above only touched item_statuses.
  SELECT MIN(ARRAY_POSITION(
           ARRAY['pending', 'received', 'paid', 'on_the_way', 'completed'],
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
  ) AS keyed
  WHERE COALESCE(o.item_statuses ->> keyed.key, o.status) <> 'cancelled';

  IF min_ord IS NOT NULL THEN
    UPDATE public.orders
    SET status = (ARRAY['pending', 'received', 'paid', 'on_the_way', 'completed'])[min_ord]
    WHERE id = p_order_id;
  ELSE
    UPDATE public.orders SET status = 'cancelled' WHERE id = p_order_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
