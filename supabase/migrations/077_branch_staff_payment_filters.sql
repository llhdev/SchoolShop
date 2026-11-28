-- Timor Shop: branch staff get the Paid and Needs review filters (077).
-- Run after 076_order_line_search_variants.sql.
--
-- Since 073 branch staff mark their scoped items paid and verify payments,
-- and 074 lets them read the Payment Verification card — but the merged
-- Orders page still hid the 'paid' and 'needs_review' filters from them
-- (070's guard rejects both for anyone without the financial capability),
-- so a branch admin had no way to list the very items they had just paid
-- or the ones awaiting payment review.
--
-- Two changes to get_scoped_order_lines (070 body otherwise unchanged):
--   1. The 'paid' / 'needs_review' filter guard now also passes for callers
--      with the branch capability. Scoping is untouched: branch-stamped
--      staff still see only their branch's lines (+ unstamped legacy, 053),
--      money stays stripped, and the base helper's needs_review predicate
--      already scopes to visible lines.
--   2. The per-row payment_warning now also rides out to branch-capability
--      callers (their own tenant's entry only, never another shop's), so
--      the Needs review badge can render its reason. 074 already approved
--      branch staff seeing warning state on OrderDetail; this is the same
--      data on the list.

CREATE OR REPLACE FUNCTION public.get_scoped_order_lines(
  p_tenant_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_after_created_at timestamptz DEFAULT NULL,
  p_after_id text DEFAULT NULL,
  p_limit int DEFAULT 100
)
RETURNS jsonb AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_super boolean;
  v_parent uuid;
  v_tenant uuid;
  v_financial boolean;
  v_branch_cap boolean;
  v_branch uuid;
  v_branch_selection boolean;
  v_full boolean;
  v_branch_scoped boolean;
  v_search text := NULLIF(BTRIM(COALESCE(p_search, '')), '');
  v_limit int;
  v_rows jsonb;
  v_total_count integer;
  v_total_revenue numeric;
  v_has_more boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  v_super := public.is_super_admin();

  SELECT p.parent_tenant_id, p.staff_financial, p.staff_branch, p.branch_id
  INTO v_parent, v_financial, v_branch_cap, v_branch
  FROM public.profiles p
  WHERE p.id = v_uid;

  IF v_super THEN
    -- The merged page always passes the picked shop; NULL = all shops.
    v_tenant := p_tenant_id;
    v_full := true;
  ELSE
    -- Everyone else is forced to their own shop; p_tenant_id is ignored.
    v_tenant := COALESCE(v_parent, v_uid);
    v_full := COALESCE(v_financial, false);
  END IF;

  -- The shop's checkout branch-selection toggle (046): off = items carry no
  -- branch stamp, so branch scoping does not apply (047).
  SELECT COALESCE(p.branch_selection_enabled, true)
  INTO v_branch_selection
  FROM public.profiles p
  WHERE p.id = v_tenant;

  v_branch_scoped := NOT v_super
    AND COALESCE(v_branch_cap, false)
    AND v_branch IS NOT NULL
    AND COALESCE(v_branch_selection, true);

  IF p_status IS NOT NULL AND p_status NOT IN
     ('pending', 'received', 'paid', 'on_the_way', 'completed', 'cancelled', 'needs_review') THEN
    RAISE EXCEPTION 'Invalid status filter: %', p_status;
  END IF;
  -- 'paid' and 'needs_review' are payment-operations filters: financial staff
  -- (070) and, since 077, branch staff — they mark scoped items paid (073)
  -- and verify payments. Everyone else is rejected.
  IF p_status IN ('paid', 'needs_review')
     AND NOT v_full AND NOT COALESCE(v_branch_cap, false) THEN
    RAISE EXCEPTION 'This filter requires the financial or branch capability.';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);

  -- Totals over EVERY matching visible line (all pages; no cursor).
  SELECT COUNT(*), COALESCE(SUM(b.line_total), 0)
  INTO v_total_count, v_total_revenue
  FROM public._scoped_order_lines_base(
    v_tenant, v_branch_scoped, v_branch, p_status, p_from, p_to, v_search
  ) AS b;

  -- One page: keyset cursor on the (created_at, id) order tuple, newest
  -- first; DENSE_RANK numbers the orders so exactly v_limit ORDERS (with all
  -- their lines) come back per page.
  WITH ranked AS (
    SELECT b.*,
           DENSE_RANK() OVER (ORDER BY b.created_at DESC, b.order_id DESC) AS order_rank
    FROM public._scoped_order_lines_base(
      v_tenant, v_branch_scoped, v_branch, p_status, p_from, p_to, v_search
    ) AS b
    WHERE (p_after_created_at IS NULL
           OR (b.created_at, b.order_id) < (p_after_created_at, p_after_id))
  ),
  page AS (
    SELECT * FROM ranked WHERE order_rank <= v_limit
  )
  SELECT
    COALESCE(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'order_id', p.order_id,
           'created_at', p.created_at,
           'item_key', p.item_key,
           'product_name', p.product_name,
           'quantity', p.quantity,
           'unit_price', CASE WHEN v_full THEN p.unit_price ELSE NULL END,
           'line_total', CASE WHEN v_full THEN p.line_total ELSE NULL END,
           'line_status', p.line_status,
           'order_status', p.order_status,
           'phone_number', p.phone_number,
           'location', p.location,
           'telegram_first_name', s.first_name,
           'telegram_last_name', s.last_name,
           'telegram_username', s.username,
           'field_answers', p.field_answers,
           'branch_id', p.branch_id,
           'branch_name', p.branch_name,
           'payment_method', p.payment_method,
           'payment_warning', CASE
             WHEN (v_full OR COALESCE(v_branch_cap, false)) AND v_tenant IS NOT NULL
             THEN p.payment_warnings -> v_tenant::text
             ELSE NULL
           END
         )
         ORDER BY p.created_at DESC, p.order_id DESC, p.item_ord
       )
       FROM page p
       LEFT JOIN public.shoppers s ON s.telegram_id = p.telegram_id),
      '[]'::jsonb),
    (SELECT COALESCE(MAX(ranked.order_rank), 0) > v_limit FROM ranked)
  INTO v_rows, v_has_more;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total_count', v_total_count,
    'total_revenue', CASE WHEN v_full THEN v_total_revenue ELSE NULL END,
    'has_more', COALESCE(v_has_more, false)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_scoped_order_lines(uuid, text, timestamptz, timestamptz, text, timestamptz, text, int)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_scoped_order_lines(uuid, text, timestamptz, timestamptz, text, timestamptz, text, int)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
