-- Timor Shop: branch staff may mark their scoped items paid (073).
-- Run after 072_cancel_remarks_and_status_relaxations.sql.
--
-- One approved capability widening: callers with the BRANCH capability
-- (staff_branch) may now transition their scoped line items to 'paid', under
-- exactly the same branch scoping rules as their other statuses (the item
-- lookup already restricts branch staff to items stamped with their branch,
-- with unstamped items — 053 — shop-wide for them). The 072 pending→paid
-- direct relaxation extends to branch callers the same way (the forward-only
-- matrix already allows it).
--
-- Everything else is byte-identical to 072: reference claiming on paid (067),
-- payment_warnings cleanup on paid (072), cancel remarks, un-cancel, the
-- order-level status recompute, and the grants. Financial-only surfaces are
-- untouched.

DROP FUNCTION public.update_order_item_status(text, text, text, text, text);

CREATE FUNCTION public.update_order_item_status(
  p_order_id text,
  p_item_key text,
  p_status text,
  p_cancel_reason text DEFAULT NULL,
  p_cancel_detail text DEFAULT NULL
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
  v_item_owner text;
  v_ref jsonb;
  v_claimed text;
BEGIN
  IF p_status NOT IN ('pending', 'received', 'paid', 'on_the_way', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid item status: %', p_status;
  END IF;

  -- 072: a cancellation without a reason is rejected before anything else.
  IF p_status = 'cancelled' AND (p_cancel_reason IS NULL OR btrim(p_cancel_reason) = '') THEN
    RAISE EXCEPTION 'A cancel reason is required.';
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
    -- 073: branch staff may mark THEIR scoped items paid too — the item
    -- lookup below enforces the same scoping as their other statuses.
    IF p_status = 'paid'
       AND NOT (COALESCE(v_can_financial, false) OR COALESCE(v_can_branch, false)) THEN
      RAISE EXCEPTION 'Only the financial or branch admin can mark orders paid.';
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
  -- 067 also captures the item's owner tenant for the paid-transition claim.
  SELECT keyed.key, keyed.owner INTO item_key, v_item_owner
  FROM (
    SELECT
      it,
      COALESCE(it->'product'->>'owner_id', it->'product'->>'ownerId') AS owner,
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
        keyed.owner = v_tenant::text
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
  -- 072 relaxations: financial staff may mark paid straight from pending
  -- (skipping received) — 073 extends that to branch staff — and a cancelled
  -- line may be restored to pending, the ONLY backward step, allowed for
  -- exactly the callers who may cancel (branch staff, checked below; the
  -- super admin is exempt from all of this).
  v_current := COALESCE(o.item_statuses ->> p_item_key, o.status);
  IF NOT public.is_super_admin() AND NOT (
    (v_current = 'pending'    AND p_status IN ('received', 'paid', 'cancelled')) OR
    (v_current = 'received'   AND p_status IN ('paid', 'cancelled')) OR
    (v_current = 'paid'       AND p_status = 'on_the_way') OR
    (v_current = 'on_the_way' AND p_status = 'completed') OR
    (v_current = 'cancelled'  AND p_status = 'pending')
  ) THEN
    RAISE EXCEPTION 'Invalid status change from % to %.', v_current, p_status;
  END IF;

  -- 072: restoring a cancelled line is the branch admin's call, exactly like
  -- cancelling it (the item lookup above already scopes branch staff to
  -- their branch's items).
  IF NOT public.is_super_admin()
     AND v_current = 'cancelled' AND p_status = 'pending'
     AND NOT COALESCE(v_can_branch, false) THEN
    RAISE EXCEPTION 'Only the branch admin can restore a cancelled item.';
  END IF;

  -- 067: marking paid is a manual approval of the payment, so it must burn
  -- the receipt the same way the verification Approve action does — claim the
  -- order's stored reference atomically and refuse the transition when
  -- another order got there first. Same-order conflicts are fine: multi-item
  -- orders are marked paid item by item, and re-claiming your own order is a
  -- no-op. No stored reference = nothing to claim (verification disabled or
  -- the proof carried no usable reference).
  IF p_status = 'paid' THEN
    v_ref := o.payment_references -> v_item_owner;
    IF v_ref IS NOT NULL AND v_ref ? 'provider' AND v_ref ? 'reference' THEN
      INSERT INTO public.payment_claims (provider, reference, order_id, tenant_id)
      VALUES (v_ref->>'provider', v_ref->>'reference', p_order_id, v_item_owner::uuid)
      ON CONFLICT (provider, reference) DO NOTHING
      RETURNING order_id INTO v_claimed;

      IF v_claimed IS NULL THEN
        SELECT order_id INTO v_claimed FROM public.payment_claims
        WHERE provider = v_ref->>'provider' AND reference = v_ref->>'reference';
        IF v_claimed IS DISTINCT FROM p_order_id THEN
          RAISE EXCEPTION 'This payment reference was already used for order %.', v_claimed;
        END IF;
      END IF;
    END IF;
  END IF;

  -- 072: the status write also maintains the two side columns —
  -- cancel_remarks (record on cancel with the required reason, remove on
  -- un-cancel) and payment_warnings (delete the tenant's entry on paid, the
  -- same thing manual-verify-reference does after a successful verification).
  UPDATE public.orders
  SET item_statuses = jsonb_set(item_statuses, ARRAY[p_item_key], to_jsonb(p_status), true),
      cancel_remarks = CASE
        WHEN p_status = 'cancelled' THEN
          jsonb_set(
            COALESCE(cancel_remarks, '{}'::jsonb),
            ARRAY[p_item_key],
            jsonb_build_object(
              'reason', btrim(p_cancel_reason),
              'detail', NULLIF(btrim(COALESCE(p_cancel_detail, '')), ''),
              'at', now()
            ),
            true
          )
        WHEN v_current = 'cancelled' AND p_status = 'pending' THEN
          COALESCE(cancel_remarks, '{}'::jsonb) - p_item_key
        ELSE cancel_remarks
      END,
      payment_warnings = CASE
        WHEN p_status = 'paid' THEN COALESCE(payment_warnings, '{}'::jsonb) - v_item_owner
        ELSE payment_warnings
      END
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

REVOKE ALL ON FUNCTION public.update_order_item_status(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_item_status(text, text, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
