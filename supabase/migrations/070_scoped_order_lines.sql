-- Timor Shop: scoped order lines (070).
-- Run after 069_verification_start_cutoff.sql.
--
-- The admin Orders and Analysis pages merge into one paginated line-item
-- table. Until now both rendered from the FULL order history the client
-- downloads into context: get_scoped_orders (064) walks every order in a
-- PL/pgSQL string-concatenation loop, and the analysis screen then
-- re-flattened those rows in JS. That is the performance problem this
-- migration kills:
--
--   1. _scoped_order_lines_base(...) — private set-based helper returning one
--      row per VISIBLE line item (tenant + branch scoping, status filter on
--      the effective line status, server-side search) via jsonb path ops +
--      LATERAL. No loop, no string concatenation.
--   2. get_scoped_order_lines(...) — public RPC wrapping the helper with
--      keyset pagination BY ORDER ((created_at, id) tuple cursor, newest
--      first, lines of one order stay together), plus totals over every
--      matching line (not just the page). Returns a single jsonb object:
--      { rows, total_count, total_revenue, has_more }.
--   3. get_scoped_order(p_order_id) — one order under the exact 064 rules
--      (full row for super admin / financial staff, money strip + branch
--      scoping for everyone else), so OrderDetail works for orders that are
--      no longer in the client's context cache.
--
-- Capability rules mirror 064 exactly:
--   * super admin: may pass p_tenant_id to view one shop's lines (NULL = all
--     shops); always sees money.
--   * financial staff: their own shop's lines (p_tenant_id ignored), money
--     visible, plus the financial-only 'paid' and 'needs_review' filters.
--   * shop staff: their own shop's lines, unit_price/line_total NULLed and
--     total_revenue NULL (money stripped SERVER-SIDE, not just in the UI).
--   * branch staff: only lines stamped with their branch_id PLUS unstamped
--     (shop-wide) legacy lines (053); no scoping at all when the shop's
--     branch_selection_enabled is off (047); money stripped the same way.
--   * payment_warning rides each row for financial viewers only (the tenant's
--     own payment_warnings entry), powering the "Needs review" filter.
--
-- The per-line key is recomputed exactly the way the client builds it
-- (getCartItemLineId in src/utils/variants.ts, same expression as 038/067):
-- "productId:selectedImageIndex" plus ":Group=Option|…" for variant lines.
-- The effective line status is item_statuses->>key with a fallback to the
-- order-level status (022/039).

-- ---------------------------------------------------------------------------
-- 1. Private base: one row per visible line item. Caller-computed scope is
--    passed in as plain parameters, so this helper itself makes no auth
--    decisions — EXECUTE is revoked from everyone; only the SECURITY DEFINER
--    wrappers below (whose owner has all privileges) can call it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._scoped_order_lines_base(
  p_tenant uuid,
  p_branch_scoped boolean,
  p_branch uuid,
  p_status text,
  p_from timestamptz,
  p_to timestamptz,
  p_search text
)
RETURNS TABLE (
  order_id text,
  created_at timestamptz,
  order_status text,
  phone_number text,
  location text,
  payment_method text,
  telegram_id bigint,
  payment_warnings jsonb,
  item_key text,
  product_name text,
  quantity numeric,
  unit_price numeric,
  line_total numeric,
  line_status text,
  field_answers jsonb,
  branch_id text,
  branch_name text,
  item_ord bigint
) AS $$
  SELECT
    o.id AS order_id,
    o.created_at,
    o.status AS order_status,
    o.phone_number,
    COALESCE(o.location, '') AS location,
    o.payment_method,
    o.telegram_id,
    o.payment_warnings,
    k.item_key,
    -- Product name carries the variant label ("Name (Size 42 · Color Black)"),
    -- matching formatVariantLabel in src/utils/variants.ts, so variant lines
    -- of one product stay distinguishable in the flat table.
    (it->'product'->>'name') ||
      CASE
        WHEN jsonb_array_length(COALESCE(it->'selectedOptions', '[]'::jsonb)) > 0
        THEN ' (' || (
          SELECT string_agg((opt->>'group') || ' ' || (opt->>'option'), ' · ' ORDER BY o2.ord)
          FROM jsonb_array_elements(it->'selectedOptions') WITH ORDINALITY AS o2(opt, ord)
        ) || ')'
        ELSE ''
      END AS product_name,
    COALESCE((it->>'quantity')::numeric, 0) AS quantity,
    COALESCE((it->>'unitPrice')::numeric, (it->'product'->>'price')::numeric, 0) AS unit_price,
    COALESCE((it->>'unitPrice')::numeric, (it->'product'->>'price')::numeric, 0)
      * COALESCE((it->>'quantity')::numeric, 0) AS line_total,
    COALESCE(o.item_statuses ->> k.item_key, o.status) AS line_status,
    COALESCE(it->'fieldAnswers', '[]'::jsonb) AS field_answers,
    it->>'branchId' AS branch_id,
    it->>'branchName' AS branch_name,
    t.ord AS item_ord
  FROM public.orders o
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) WITH ORDINALITY AS t(it, ord)
  CROSS JOIN LATERAL (
    SELECT it->'product'->>'id' || ':' || COALESCE(it->>'selectedImageIndex', '0') ||
      CASE
        WHEN jsonb_array_length(COALESCE(it->'selectedOptions', '[]'::jsonb)) > 0
        THEN ':' || (
          SELECT string_agg((opt->>'group') || '=' || (opt->>'option'), '|' ORDER BY o2.ord)
          FROM jsonb_array_elements(it->'selectedOptions') WITH ORDINALITY AS o2(opt, ord)
        )
        ELSE ''
      END AS item_key
  ) AS k
  -- Tenant scoping (064): the order lists the tenant AND the line belongs to
  -- it. p_tenant NULL (super admin without a picked shop) = every line.
  WHERE (p_tenant IS NULL OR o.tenant_ids @> ARRAY[p_tenant]::uuid[])
    AND (p_tenant IS NULL
         OR COALESCE(it->'product'->>'owner_id', it->'product'->>'ownerId') = p_tenant::text)
    -- Branch scoping (047/053): only this branch's stamp or no stamp at all.
    AND (NOT p_branch_scoped
         OR it->>'branchId' IS NULL
         OR it->>'branchId' = p_branch::text)
    AND (p_from IS NULL OR o.created_at >= p_from)
    AND (p_to IS NULL OR o.created_at <= p_to)
    -- Status filter on the EFFECTIVE line status. 'needs_review' is handled
    -- per-order below (all visible lines of a warned order are shown).
    AND (p_status IS NULL
         OR p_status = 'needs_review'
         OR COALESCE(o.item_statuses ->> k.item_key, o.status) = p_status)
    -- Search: order-level fields (id, phone, location) keep the whole order;
    -- otherwise only lines whose product name or checkout answers match.
    AND (p_search IS NULL
         OR o.id ILIKE '%' || p_search || '%'
         OR o.phone_number ILIKE '%' || p_search || '%'
         OR COALESCE(o.location, '') ILIKE '%' || p_search || '%'
         OR it->'product'->>'name' ILIKE '%' || p_search || '%'
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(it->'fieldAnswers', '[]'::jsonb)) AS fa
           WHERE fa->>'value' ILIKE '%' || p_search || '%'
         ))
    -- 'needs_review' (056): the order carries a payment warning for the line's
    -- owner tenant and that tenant still has a line awaiting payment —
    -- mirrors hasPaymentWarning in src/services/orders.ts.
    AND (p_status IS NULL
         OR p_status <> 'needs_review'
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(o.items, '[]'::jsonb)) AS x
           CROSS JOIN LATERAL (
             SELECT x->'product'->>'id' || ':' || COALESCE(x->>'selectedImageIndex', '0') ||
               CASE
                 WHEN jsonb_array_length(COALESCE(x->'selectedOptions', '[]'::jsonb)) > 0
                 THEN ':' || (
                   SELECT string_agg((opt->>'group') || '=' || (opt->>'option'), '|' ORDER BY o2.ord)
                   FROM jsonb_array_elements(x->'selectedOptions') WITH ORDINALITY AS o2(opt, ord)
                 )
                 ELSE ''
               END AS item_key
           ) AS kx
           WHERE (p_tenant IS NULL
                  OR COALESCE(x->'product'->>'owner_id', x->'product'->>'ownerId') = p_tenant::text)
             AND (NOT p_branch_scoped
                  OR x->>'branchId' IS NULL
                  OR x->>'branchId' = p_branch::text)
             AND o.payment_warnings ? COALESCE(x->'product'->>'owner_id', x->'product'->>'ownerId')
             AND COALESCE(o.item_statuses ->> kx.item_key, o.status) IN ('pending', 'received')
         ))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public._scoped_order_lines_base(uuid, boolean, uuid, text, timestamptz, timestamptz, text)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. get_scoped_order_lines: identity/scoping copied from 064's
--    get_scoped_orders, keyset pagination BY ORDER over the base rows.
--    Page order ranks are per-order (DENSE_RANK ties on the order tuple), so
--    a page's lines always stay together. totals cover every matching line,
--    not just the page.
-- ---------------------------------------------------------------------------
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
  -- 'paid' and 'needs_review' are financial-only filters on the merged page.
  IF p_status IN ('paid', 'needs_review') AND NOT v_full THEN
    RAISE EXCEPTION 'This filter requires the financial capability.';
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
             WHEN v_full AND v_tenant IS NOT NULL THEN p.payment_warnings -> v_tenant::text
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

-- ---------------------------------------------------------------------------
-- 3. get_scoped_order: one order under the exact 064 rules, for OrderDetail
--    screens opened on orders that are not in the client's context cache.
--    Full row for the super admin / financial staff; money strip + branch
--    scoping for everyone else (proofs kept for branch staff only). NULL when
--    the order does not exist, is not the caller's shop's, or has no lines
--    visible to a branch-scoped caller.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_scoped_order(p_order_id text)
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

  SELECT COALESCE(p.branch_selection_enabled, true)
  INTO v_branch_selection
  FROM public.profiles p
  WHERE p.id = v_tenant;

  v_full := v_super OR COALESCE(v_financial, false);
  v_branch_scoped := COALESCE(v_branch_cap, false)
    AND v_branch IS NOT NULL
    AND COALESCE(v_branch_selection, true);

  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Tenant membership gate (064's orders SELECT policy shape).
  IF NOT v_super AND NOT (o.tenant_ids @> ARRAY[v_tenant]::uuid[]) THEN
    RETURN NULL;
  END IF;

  -- Full unsanitized row for the super admin / financial staff.
  IF v_full THEN
    RETURN to_jsonb(o);
  END IF;

  -- Money strip per line: everything survives except the unit-price snapshot
  -- and the snapshot product price. Branch-scoped callers get only their
  -- branch's items plus unstamped (shop-wide) legacy items.
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
    RETURN NULL;
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

  RETURN v_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_scoped_order(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_scoped_order(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
