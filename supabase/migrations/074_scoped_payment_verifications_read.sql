-- Timor Shop: branch staff read payment verifications, scoped (074).
-- Run after 073_branch_staff_can_mark_paid.sql.
--
-- Approved visibility widening: branch staff now SEE the OrderDetail
-- "Payment Verification" card (status, checks breakdown, error detail) —
-- READ-ONLY. Retry/approve (052) and set_order_payment_reference (067) stay
-- financial-only, and the payment_verifications table RLS (064: super admin
-- or effective-tenant financial) is NOT loosened; this SECURITY DEFINER RPC
-- is the only new read path.
--
-- Trust decision: a caller receives the order's current verification
-- attempt(s) only when the order contains at least one line item in THEIR
-- scope — the exact scoping get_scoped_order (070) and
-- update_order_item_status apply: staff with a branch_id (while the shop's
-- branch_selection_enabled is on) see orders only through items stamped
-- with their branch, with unstamped items (053) shop-wide for them. The
-- returned columns are exactly what the card renders — the raw verify.et
-- payload (payment_verifications.raw) is excluded. Amounts (expected vs
-- paid) are included: approved — branch staff already see proofs and their
-- items' prices.

CREATE OR REPLACE FUNCTION public.get_scoped_payment_verifications(p_order_id text)
RETURNS TABLE (
  id uuid,
  order_id text,
  tenant_id uuid,
  attempt_no integer,
  status text,
  checks jsonb,
  expected_amount numeric,
  paid_amount numeric,
  provider text,
  reference text,
  receiver_account text,
  payer text,
  transaction_date timestamptz,
  updated_at timestamptz
) AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_super boolean;
  v_parent uuid;
  v_tenant uuid;
  v_branch uuid;
  v_branch_cap boolean;
  v_active boolean;
  v_branch_selection boolean;
  v_branch_scoped boolean;
  o public.orders%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  v_super := public.is_super_admin();

  SELECT p.parent_tenant_id, p.branch_id, p.staff_branch, COALESCE(p.is_active, true)
  INTO v_parent, v_branch, v_branch_cap, v_active
  FROM public.profiles p
  WHERE p.id = v_uid;
  v_tenant := COALESCE(v_parent, v_uid);

  IF NOT v_super THEN
    -- Only active tenant staff of a shop in this order may read (mirrors the
    -- membership gate in get_scoped_order, 070).
    IF NOT v_active OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role = 'admin') THEN
      RETURN;
    END IF;

    -- Qualified: RETURNS TABLE makes `id` an OUT variable, so a bare
    -- `WHERE id = ...` is ambiguous (42702).
    SELECT * INTO o FROM public.orders WHERE public.orders.id = p_order_id;
    IF NOT FOUND OR NOT (o.tenant_ids @> ARRAY[v_tenant]::uuid[]) THEN
      RETURN;
    END IF;

    SELECT COALESCE(p.branch_selection_enabled, true)
    INTO v_branch_selection
    FROM public.profiles p
    WHERE p.id = v_tenant;

    -- Same scoping as 070/073: branch-stamped callers need at least one
    -- in-scope line item (their branch's stamp, or unstamped — 053).
    v_branch_scoped := COALESCE(v_branch_cap, false)
      AND v_branch IS NOT NULL
      AND COALESCE(v_branch_selection, true);
    IF v_branch_scoped AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS it
      WHERE COALESCE(it->'product'->>'owner_id', it->'product'->>'ownerId') = v_tenant::text
        AND (it->>'branchId' IS NULL OR it->>'branchId' = v_branch::text)
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
    SELECT v.id, v.order_id, v.tenant_id, v.attempt_no, v.status, v.checks,
           v.expected_amount, v.paid_amount, v.provider, v.reference,
           v.receiver_account, v.payer, v.transaction_date, v.updated_at
    FROM public.payment_verifications v
    WHERE v.order_id = p_order_id
      AND v.is_current
      AND (v_super OR v.tenant_id = v_tenant)
    ORDER BY v.tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_scoped_payment_verifications(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_scoped_payment_verifications(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
