-- Timor Shop: capability-scoped order reads (064).
-- Run after 063_order_trigger_money_and_passwords.sql.
--
-- Audit finding #13: "staff can't see money" was enforced only in the UI.
-- 062's orders SELECT policy was tenant-scoped, not capability-scoped, so
-- EVERY staff account of a shop downloaded full order rows — total,
-- shipping_fees, per-item price snapshots, payment_proofs refs and
-- payment_references — even without the Financial capability (045). 052's
-- payment_verifications SELECT policy had the same shape. Enforcement moves
-- server-side here:
--   1. the direct orders table read becomes super-admin / financial-only;
--   2. payment_verifications reads likewise require the Financial capability;
--   3. non-financial staff fetch orders through the new get_scoped_orders
--      RPC, which returns tenant-scoped rows with the money stripped
--      (total, per-item prices, shipping fees, payment references; proofs
--      only for branch staff) and branch scoping applied server-side.
--
-- Side effect: realtime order updates stop arriving for non-financial staff
-- (realtime row events require SELECT via the table policy, which they no
-- longer satisfy). Their order lists refresh on fetch — launch, screen focus
-- and pull-to-refresh paths — not live. Super admin and financial staff keep
-- their realtime stream.
--
-- payment_warnings (056) deliberately stay visible to ALL staff: the
-- "needs review" badge tells branch staff to eyeball the proof before
-- marking received/paid, and the orders screen surfaces it without money
-- gating (AdminOrdersScreen/OrderDetailScreen comments). It carries no money
-- amounts — only a reason and an optional detail string.

-- ---------------------------------------------------------------------------
-- 1. Orders SELECT: super admin, or the shop's financial staff --------------
--    Same tenant membership test as 062, plus the Financial capability gate
--    (052's has_financial_capability). Everyone else uses get_scoped_orders.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins read scoped orders" ON public.orders;

CREATE POLICY "Admins read scoped orders"
  ON public.orders FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      tenant_ids @> ARRAY[public.effective_tenant_id()]::uuid[]
      AND public.has_financial_capability()
    )
  );

-- ---------------------------------------------------------------------------
-- 2. payment_verifications SELECT: same gate (052's policy was any tenant
--    member). Verification rows carry amounts, payer names and references.
-- ---------------------------------------------------------------------------
DROP POLICY "Admins read payment verifications" ON public.payment_verifications;

CREATE POLICY "Admins read payment verifications"
  ON public.payment_verifications FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      tenant_id = public.effective_tenant_id()
      AND public.has_financial_capability()
    )
  );

-- ---------------------------------------------------------------------------
-- 3. get_scoped_orders: order list for staff WITHOUT the Financial
--    capability. Authenticated only. Returns a jsonb array of order objects
--    (column names as keys, same shape as the table read the client maps),
--    newest first.
--
--    For the super admin or financial staff (the client routes those to the
--    direct table read, but an accidental call stays correct) the full
--    unsanitized rows come back. For everyone else, per order:
--      * total := 0, shipping_fees := '{}', payment_references := '{}';
--      * inside each items element: unitPrice := 0 and product.price := 0
--        (product name/images, quantity, fieldAnswers, branchName survive);
--      * payment_proofs := '{}' unless the caller has the Branch capability
--        (branch staff check proofs before marking items received);
--      * telegram_notifications := '{}' — server-only message locators whose
--        caption text contains the order's money lines (057);
--      * payment_warnings kept (see header).
--    Branch scoping mirrors getOrderItemsForScope / update_order_item_status
--    (045/046/047/053): when the caller has the Branch capability, a non-null
--    branch_id, AND the shop's branch_selection_enabled is on, items are
--    filtered to their branch's stamp or no stamp at all (unstamped legacy
--    items are shop-wide); orders left with zero items are dropped.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_scoped_orders()
RETURNS jsonb AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_parent uuid;
  v_tenant uuid;
  v_financial boolean;
  v_branch_cap boolean;
  v_branch uuid;
  v_branch_selection boolean;
  v_super boolean;
  v_full boolean;
  v_branch_scoped boolean;
  v_result jsonb := '[]'::jsonb;
  o public.orders%ROWTYPE;
  v_items jsonb;
  v_row jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  v_super := public.is_super_admin();

  SELECT p.parent_tenant_id, p.staff_financial, p.staff_branch, p.branch_id
  INTO v_parent, v_financial, v_branch_cap, v_branch
  FROM public.profiles p
  WHERE p.id = v_uid;
  v_tenant := COALESCE(v_parent, v_uid);

  -- The shop's checkout branch-selection toggle (046): off = items carry no
  -- branch stamp, so branch scoping does not apply.
  SELECT COALESCE(p.branch_selection_enabled, true)
  INTO v_branch_selection
  FROM public.profiles p
  WHERE p.id = v_tenant;

  -- Full rows for the super admin / financial staff (normally routed to the
  -- direct table read client-side; this keeps an accidental call correct).
  v_full := v_super OR COALESCE(v_financial, false);
  v_branch_scoped := COALESCE(v_branch_cap, false)
    AND v_branch IS NOT NULL
    AND COALESCE(v_branch_selection, true);

  FOR o IN
    SELECT * FROM public.orders
    WHERE v_super OR tenant_ids @> ARRAY[v_tenant]::uuid[]
    ORDER BY created_at DESC
  LOOP
    IF v_full THEN
      v_result := v_result || jsonb_build_array(to_jsonb(o));
      CONTINUE;
    END IF;

    -- Money strip per line: everything survives except the unit-price
    -- snapshot and the snapshot product price. Branch-scoped callers get
    -- only their branch's items plus unstamped (shop-wide) legacy items.
    SELECT COALESCE(jsonb_agg(
             jsonb_set(
               jsonb_set(it, '{unitPrice}', '0'::jsonb, true),
               '{product,price}', '0'::jsonb, true)),
           '[]'::jsonb)
    INTO v_items
    FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS it
    WHERE NOT v_branch_scoped
       OR it->>'branchId' IS NULL
       OR it->>'branchId' = v_branch::text;

    -- Nothing of this order is visible to a branch-scoped caller.
    IF v_branch_scoped AND jsonb_array_length(v_items) = 0 THEN
      CONTINUE;
    END IF;

    v_row := to_jsonb(o) || jsonb_build_object(
      'total', 0,
      'shipping_fees', '{}'::jsonb,
      'payment_references', '{}'::jsonb,
      'telegram_notifications', '{}'::jsonb,
      'items', v_items
    );
    -- Proofs: branch staff only (financial/super took the full-row path).
    IF NOT COALESCE(v_branch_cap, false) THEN
      v_row := v_row || jsonb_build_object('payment_proofs', '{}'::jsonb);
    END IF;

    v_result := v_result || jsonb_build_array(v_row);
  END LOOP;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_scoped_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_scoped_orders() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. payment_claims SELECT: same gate (052's policy was any tenant member).
--    Claim rows tie order ids to payment references — money metadata.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins read payment claims" ON public.payment_claims;

CREATE POLICY "Admins read payment claims"
  ON public.payment_claims FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      tenant_id = public.effective_tenant_id()
      AND public.has_financial_capability()
    )
  );

NOTIFY pgrst, 'reload schema';
