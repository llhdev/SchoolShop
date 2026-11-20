-- Timor Shop: claim the payment reference when an item is marked paid, and let
-- financial staff record a reference manually (067).
-- Run after 066_functions_base_url_from_vault.sql.
--
-- The used-reference ledger (payment_claims, 040) was only written by the
-- verification Approve action, so a financial admin marking an item paid
-- through the normal status path left the receipt usable for a second order.
-- Two changes close that:
--   1. update_order_item_status now claims the order's stored reference
--      atomically whenever an item moves to 'paid'. A conflict with a
--      DIFFERENT order refuses the transition with a clear error; a conflict
--      with the SAME order is idempotent (multi-item orders are marked paid
--      one item at a time). Orders with no stored reference (verification off,
--      unreadable proof) transition as before — nothing to claim.
--   2. New RPC set_order_payment_reference lets the super admin or a shop's
--      financial staff type the transaction reference off the receipt image
--      when OCR/verification produced none (the payment-warning path, 056).
--      Same provider/format validation as the checkout pre-check
--      (verify-payment-reference), same atomic duplicate check, then the
--      reference is stored on the order so the paid-transition claim (and any
--      later shopper checkout with the same receipt) sees it.

-- 1. Claim on paid -------------------------------------------------------------
--
-- Same as 053, plus: the item lookup also captures the item's owner tenant,
-- and a validated 'paid' transition claims payment_references->owner before
-- the status write (an exception rolls the whole statement back).

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
  v_item_owner text;
  v_ref jsonb;
  v_claimed text;
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
  v_current := COALESCE(o.item_statuses ->> p_item_key, o.status);
  IF NOT public.is_super_admin() AND NOT (
    (v_current = 'pending'    AND p_status IN ('received', 'cancelled')) OR
    (v_current = 'received'   AND p_status IN ('paid', 'cancelled')) OR
    (v_current = 'paid'       AND p_status = 'on_the_way') OR
    (v_current = 'on_the_way' AND p_status = 'completed')
  ) THEN
    RAISE EXCEPTION 'Invalid status change from % to %.', v_current, p_status;
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

-- 2. Manual reference entry ----------------------------------------------------
--
-- For orders whose proof could not be verified automatically (payment
-- warning, 056 — OCR unreadable, verify.et down, reference not found): the
-- financial admin reads the transaction reference off the receipt image and
-- records it here. The reference is validated with the same rules the
-- checkout pre-check uses, stored on the order (key 'manual' — no verify.et
-- idempotency key exists), and claimed atomically so a duplicate is rejected
-- at entry time, not later.

CREATE OR REPLACE FUNCTION public.set_order_payment_reference(
  p_order_id text,
  p_tenant_id uuid,
  p_provider text,
  p_reference text
)
RETURNS void AS $$
DECLARE
  v_claimed text;
BEGIN
  IF NOT public.is_super_admin() AND NOT (
    public.effective_tenant_id() = p_tenant_id
    AND public.has_financial_capability()
  ) THEN
    RAISE EXCEPTION 'Only the super admin or the shop''s financial admin can record a payment reference.';
  END IF;

  p_provider := lower(trim(p_provider));
  IF p_provider NOT IN ('cbe', 'telebirr') THEN
    RAISE EXCEPTION 'Provider must be cbe or telebirr.';
  END IF;

  -- Same shapes as verify-payment-reference: Telebirr transaction numbers are
  -- uppercase alnum (6-20), CBE Receipt IDs mixed-case alnum (8-24).
  p_reference := trim(p_reference);
  IF p_provider = 'telebirr' THEN
    p_reference := upper(p_reference);
    IF p_reference !~ '^[A-Z0-9]{6,20}$' THEN
      RAISE EXCEPTION 'Reference has the wrong format for Telebirr.';
    END IF;
  ELSIF p_reference !~ '^[A-Za-z0-9]{8,24}$' THEN
    RAISE EXCEPTION 'Reference has the wrong format for CBE.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = p_order_id AND tenant_ids @> ARRAY[p_tenant_id]::uuid[]
  ) THEN
    RAISE EXCEPTION 'Order not found for this shop.';
  END IF;

  UPDATE public.orders
  SET payment_references = jsonb_set(
        COALESCE(payment_references, '{}'::jsonb),
        ARRAY[p_tenant_id::text],
        jsonb_build_object('provider', p_provider, 'reference', p_reference, 'key', 'manual'),
        true)
  WHERE id = p_order_id;

  -- The duplicate check is the atomic claim itself (same pattern as
  -- approve_payment_verification, 052): on conflict with another order the
  -- exception rolls back the UPDATE above too.
  INSERT INTO public.payment_claims (provider, reference, order_id, tenant_id)
  VALUES (p_provider, p_reference, p_order_id, p_tenant_id)
  ON CONFLICT (provider, reference) DO NOTHING
  RETURNING order_id INTO v_claimed;

  IF v_claimed IS NULL THEN
    SELECT order_id INTO v_claimed FROM public.payment_claims
    WHERE provider = p_provider AND reference = p_reference;
    IF v_claimed IS DISTINCT FROM p_order_id THEN
      RAISE EXCEPTION 'This payment reference was already used for order %.', v_claimed;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.set_order_payment_reference(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_order_payment_reference(text, uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
