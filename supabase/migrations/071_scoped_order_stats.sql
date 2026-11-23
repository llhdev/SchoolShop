-- Timor Shop: server-aggregated admin Reports (071).
-- Run after 070_scoped_order_lines.sql.
--
-- AdminReportsScreen aggregated the full order history in JS
-- (src/utils/reports.ts over context orders) — the same full-history download
-- the merged Orders page (070) just got rid of. This migration moves every
-- report number into one SECURITY DEFINER RPC, get_scoped_order_stats, which
-- computes them in SQL over 070's visible line set
-- (_scoped_order_lines_base) and returns a single jsonb document:
--
--   current        — {units, orders, revenue, customers, repeat_customers}
--                    over [p_from, p_to]; repeat_customers = phones with 2+
--                    distinct orders in the period (the repeat-rate numerator).
--   previous       — same minus repeat_customers, over [p_prev_from, p_prev_to];
--                    all-null fields when p_prev_from IS NULL (no comparison).
--   product_ranks  — per product over the current period: {product_id, label,
--                    units, revenue}, label = MIN(product_name) per product
--                    (the old JS grouped variants under the first-seen label;
--                    MIN is the deterministic equivalent), sorted units DESC,
--                    label ASC.
--   hot_week/month — top 10 of the same shape over the current CALENDAR
--                    week (since Monday) / month in client-local time,
--                    regardless of the selected period.
--   status_counts  — lines per effective line status, ALL TIME (the screen
--                    treats it as current state / to-do list).
--   weekday_counts / hour_counts — DISTINCT orders per weekday (Mon..Sun) /
--                    hour (0..23), all time, client-local time.
--   monthly_repeat — last 6 calendar months (oldest first): {label, rate,
--                    customers}; rate = share of the month's customers whose
--                    CUMULATIVE distinct-order count by month-end is 2+
--                    (mirrors monthlyRepeatRates in src/utils/reports.ts);
--                    rate null when the month had no customers.
--   locations      — current-period groups {label, orders, units} with the
--                    old JS normalization (trim, collapse whitespace, case-
--                    insensitive grouping, first spelling kept, empty →
--                    'Not specified'), sorted orders DESC, label ASC.
--   trend          — fixed-coverage {label, orders, revenue} buckets in
--                    client-local time by p_trend_mode: today → 24 hours,
--                    week → 7 days from Monday, month → days of the current
--                    local month, all → months from the first visible line to
--                    now, custom → days spanning [p_from, p_to] (month buckets
--                    when the span exceeds 62 days). Orders are DISTINCT per
--                    bucket. Trend always reads the all-time line set — the
--                    buckets themselves do the windowing (same as the old
--                    trendBuckets(lines, period)).
--
-- Money fields (revenue everywhere) are NULL — not zero — when the caller
-- lacks the financial capability. Identity/scoping copied exactly from 070:
-- super admin honors p_tenant_id (NULL = all shops) and always sees money;
-- staff are forced to COALESCE(parent_tenant_id, auth.uid()); branch scoping
-- with branch_selection_enabled (046/047/053).
--
-- All bucketing uses CLIENT-LOCAL wall time: local =
-- (created_at AT TIME ZONE 'UTC') - p_tz_offset_minutes minutes, where the
-- client passes new Date().getTimezoneOffset() — so numbers match the old
-- local-time JS computation exactly. Local-wall period bounds convert back
-- to UTC instants as (wall + p_tz_offset_minutes) AT TIME ZONE 'UTC'.
--
-- Section 0 also recreates 070's _scoped_order_lines_base with a product_id
-- column (needed for product ranks / dead-stock matching). CREATE OR REPLACE
-- cannot change a RETURNS TABLE shape, so the function is dropped first —
-- its only caller, get_scoped_order_lines, is plpgsql (no recorded
-- dependency), and the grant set is re-applied below.

-- ---------------------------------------------------------------------------
-- 0. _scoped_order_lines_base gains product_id (070 body, one column added).
-- ---------------------------------------------------------------------------
DROP FUNCTION public._scoped_order_lines_base(uuid, boolean, uuid, text, timestamptz, timestamptz, text);

CREATE FUNCTION public._scoped_order_lines_base(
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
  product_id text,
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
    it->'product'->>'id' AS product_id,
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
-- 1. get_scoped_order_stats. One jsonb with every report number; see the
--    header for the section shapes. Each section is one set-based query over
--    _scoped_order_lines_base with the scope the identity block computes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_scoped_order_stats(
  p_tenant_id uuid DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_prev_from timestamptz DEFAULT NULL,
  p_prev_to timestamptz DEFAULT NULL,
  p_tz_offset_minutes int DEFAULT 0,
  p_trend_mode text DEFAULT 'month'
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
  -- Client-local wall time (see header): local = utc_wall - tz offset.
  v_tz interval := COALESCE(p_tz_offset_minutes, 0) * interval '1 minute';
  v_local_now timestamp := (now() AT TIME ZONE 'UTC') - (COALESCE(p_tz_offset_minutes, 0) * interval '1 minute');
  v_month_names text[] := ARRAY['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  v_weekday_names text[] := ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  v_current jsonb;
  v_previous jsonb;
  v_repeat_customers integer;
  v_product_ranks jsonb;
  v_hot_week jsonb;
  v_hot_month jsonb;
  v_status_counts jsonb;
  v_weekday_counts jsonb;
  v_hour_counts jsonb;
  v_monthly_repeat jsonb;
  v_locations jsonb;
  v_trend jsonb;
  v_week_from timestamptz;
  v_month_from timestamptz;
  v_first_month timestamp;
  v_w_from timestamp;
  v_w_to timestamp;
  v_span_days int;
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
    v_tenant := p_tenant_id;
    v_full := true;
  ELSE
    v_tenant := COALESCE(v_parent, v_uid);
    v_full := COALESCE(v_financial, false);
  END IF;

  SELECT COALESCE(p.branch_selection_enabled, true)
  INTO v_branch_selection
  FROM public.profiles p
  WHERE p.id = v_tenant;

  v_branch_scoped := NOT v_super
    AND COALESCE(v_branch_cap, false)
    AND v_branch IS NOT NULL
    AND COALESCE(v_branch_selection, true);

  IF p_trend_mode NOT IN ('today', 'week', 'month', 'all', 'custom') THEN
    RAISE EXCEPTION 'Invalid trend mode: %', p_trend_mode;
  END IF;

  -- current ------------------------------------------------------------------
  WITH lines AS (
    SELECT b.*
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, p_from, p_to, NULL) b
  )
  SELECT jsonb_build_object(
    'units', COALESCE(SUM(quantity), 0),
    'orders', COUNT(DISTINCT order_id),
    'revenue', CASE WHEN v_full THEN COALESCE(SUM(line_total), 0) ELSE NULL END,
    'customers', COUNT(DISTINCT phone_number)
  )
  INTO v_current
  FROM lines;

  WITH lines AS (
    SELECT b.*
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, p_from, p_to, NULL) b
  ),
  per_phone AS (
    SELECT phone_number
    FROM lines
    GROUP BY phone_number
    HAVING COUNT(DISTINCT order_id) >= 2
  )
  SELECT COUNT(*) INTO v_repeat_customers FROM per_phone;

  v_current := v_current || jsonb_build_object('repeat_customers', v_repeat_customers);

  -- previous (all-null when no comparison period was requested) ---------------
  IF p_prev_from IS NULL THEN
    v_previous := jsonb_build_object(
      'units', NULL, 'orders', NULL, 'revenue', NULL, 'customers', NULL
    );
  ELSE
    WITH lines AS (
      SELECT b.*
      FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, p_prev_from, p_prev_to, NULL) b
    )
    SELECT jsonb_build_object(
      'units', COALESCE(SUM(quantity), 0),
      'orders', COUNT(DISTINCT order_id),
      'revenue', CASE WHEN v_full THEN COALESCE(SUM(line_total), 0) ELSE NULL END,
      'customers', COUNT(DISTINCT phone_number)
    )
    INTO v_previous
    FROM lines;
  END IF;

  -- product_ranks (current period) -------------------------------------------
  WITH lines AS (
    SELECT b.*
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, p_from, p_to, NULL) b
  ),
  ranked AS (
    SELECT product_id,
           MIN(product_name) AS label,
           SUM(quantity) AS units,
           SUM(line_total) AS revenue
    FROM lines
    GROUP BY product_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'label', label,
      'units', units,
      'revenue', CASE WHEN v_full THEN revenue ELSE NULL END
    ) ORDER BY units DESC, label ASC
  ), '[]'::jsonb)
  INTO v_product_ranks
  FROM ranked;

  -- hot_week / hot_month: fixed calendar windows in client-local time ---------
  v_week_from := (date_trunc('week', v_local_now) + v_tz) AT TIME ZONE 'UTC';
  v_month_from := (date_trunc('month', v_local_now) + v_tz) AT TIME ZONE 'UTC';

  WITH lines AS (
    SELECT b.*
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, v_week_from, NULL, NULL) b
  ),
  ranked AS (
    SELECT product_id,
           MIN(product_name) AS label,
           SUM(quantity) AS units,
           SUM(line_total) AS revenue
    FROM lines
    GROUP BY product_id
    ORDER BY units DESC, MIN(product_name) ASC
    LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'label', label,
      'units', units,
      'revenue', CASE WHEN v_full THEN revenue ELSE NULL END
    ) ORDER BY units DESC, label ASC
  ), '[]'::jsonb)
  INTO v_hot_week
  FROM ranked;

  WITH lines AS (
    SELECT b.*
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, v_month_from, NULL, NULL) b
  ),
  ranked AS (
    SELECT product_id,
           MIN(product_name) AS label,
           SUM(quantity) AS units,
           SUM(line_total) AS revenue
    FROM lines
    GROUP BY product_id
    ORDER BY units DESC, MIN(product_name) ASC
    LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'label', label,
      'units', units,
      'revenue', CASE WHEN v_full THEN revenue ELSE NULL END
    ) ORDER BY units DESC, label ASC
  ), '[]'::jsonb)
  INTO v_hot_month
  FROM ranked;

  -- status_counts: lines per effective status, ALL TIME -----------------------
  WITH lines AS (
    SELECT b.*
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
  )
  SELECT jsonb_build_object(
    'pending', COUNT(*) FILTER (WHERE line_status = 'pending'),
    'received', COUNT(*) FILTER (WHERE line_status = 'received'),
    'paid', COUNT(*) FILTER (WHERE line_status = 'paid'),
    'on_the_way', COUNT(*) FILTER (WHERE line_status = 'on_the_way'),
    'completed', COUNT(*) FILTER (WHERE line_status = 'completed'),
    'cancelled', COUNT(*) FILTER (WHERE line_status = 'cancelled')
  )
  INTO v_status_counts
  FROM lines;

  -- weekday_counts / hour_counts: DISTINCT orders, all time, local time -------
  WITH lines AS (
    SELECT DISTINCT b.order_id, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
  )
  SELECT COALESCE(jsonb_agg(cnt ORDER BY wd), '[]'::jsonb)
  INTO v_weekday_counts
  FROM (
    SELECT w.wd, COUNT(l.order_id) AS cnt
    FROM generate_series(1, 7) AS w(wd)
    LEFT JOIN lines l ON EXTRACT(ISODOW FROM l.lt) = w.wd
    GROUP BY w.wd
  ) s;

  WITH lines AS (
    SELECT DISTINCT b.order_id, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
  )
  SELECT COALESCE(jsonb_agg(cnt ORDER BY hr), '[]'::jsonb)
  INTO v_hour_counts
  FROM (
    SELECT h.hr, COUNT(l.order_id) AS cnt
    FROM generate_series(0, 23) AS h(hr)
    LEFT JOIN lines l ON EXTRACT(HOUR FROM l.lt) = h.hr
    GROUP BY h.hr
  ) s;

  -- monthly_repeat: last 6 local calendar months, oldest first ----------------
  WITH lines AS (
    SELECT DISTINCT b.phone_number, b.order_id, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
  ),
  months AS (
    SELECT g.i,
           date_trunc('month', v_local_now) - ((5 - g.i) * interval '1 month') AS m_start
    FROM generate_series(0, 5) AS g(i)
  ),
  per_month AS (
    SELECT m.i,
           m.m_start,
           (SELECT COUNT(DISTINCT c.phone_number)
            FROM lines c
            WHERE c.lt >= m.m_start AND c.lt < m.m_start + interval '1 month') AS customers,
           (SELECT COUNT(*)
            FROM (
              SELECT c.phone_number
              FROM lines c
              WHERE c.lt >= m.m_start AND c.lt < m.m_start + interval '1 month'
              GROUP BY c.phone_number
              HAVING (SELECT COUNT(*)
                      FROM lines p2
                      WHERE p2.phone_number = c.phone_number
                        AND p2.lt < m.m_start + interval '1 month') >= 2
            ) r) AS repeat_customers
    FROM months m
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'label', v_month_names[EXTRACT(MONTH FROM pm.m_start)::int],
      'rate', CASE WHEN pm.customers = 0 THEN NULL
                   ELSE ROUND(100.0 * pm.repeat_customers / pm.customers)::int END,
      'customers', pm.customers
    ) ORDER BY pm.i
  ), '[]'::jsonb)
  INTO v_monthly_repeat
  FROM per_month pm;

  -- locations (current period) ------------------------------------------------
  WITH lines AS (
    SELECT b.*
    FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, p_from, p_to, NULL) b
  ),
  normed AS (
    SELECT order_id,
           quantity,
           NULLIF(LOWER(REGEXP_REPLACE(BTRIM(COALESCE(location, '')), '\s+', ' ', 'g')), '') AS key,
           REGEXP_REPLACE(BTRIM(COALESCE(location, '')), '\s+', ' ', 'g') AS raw
    FROM lines
  ),
  labels AS (
    SELECT DISTINCT ON (COALESCE(key, '(none)'))
           COALESCE(key, '(none)') AS key,
           CASE WHEN key IS NULL THEN 'Not specified' ELSE raw END AS label
    FROM normed
    ORDER BY COALESCE(key, '(none)'), raw
  ),
  agg AS (
    SELECT COALESCE(key, '(none)') AS key,
           COUNT(DISTINCT order_id) AS orders,
           COALESCE(SUM(quantity), 0) AS units
    FROM normed
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('label', l.label, 'orders', a.orders, 'units', a.units)
    ORDER BY a.orders DESC, l.label ASC
  ), '[]'::jsonb)
  INTO v_locations
  FROM agg a
  JOIN labels l USING (key);

  -- trend: fixed-coverage buckets over the ALL-TIME line set ------------------
  IF p_trend_mode = 'today' THEN
    WITH lines AS (
      SELECT b.order_id, b.line_total, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
      FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
    ),
    buckets AS (
      SELECT h AS ord,
             h::text AS label,
             date_trunc('day', v_local_now) + (h * interval '1 hour') AS bstart,
             date_trunc('day', v_local_now) + ((h + 1) * interval '1 hour') AS bend
      FROM generate_series(0, 23) AS h
    )
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('label', bk.label, 'orders', bk.orders,
                         'revenue', CASE WHEN v_full THEN bk.revenue ELSE NULL END)
      ORDER BY bk.ord
    ), '[]'::jsonb)
    INTO v_trend
    FROM (
      SELECT bk.ord, bk.label,
             COUNT(DISTINCT l.order_id) AS orders,
             COALESCE(SUM(l.line_total), 0) AS revenue
      FROM buckets bk
      LEFT JOIN lines l ON l.lt >= bk.bstart AND l.lt < bk.bend
      GROUP BY bk.ord, bk.label
    ) bk;

  ELSIF p_trend_mode = 'week' THEN
    WITH lines AS (
      SELECT b.order_id, b.line_total, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
      FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
    ),
    buckets AS (
      SELECT d AS ord,
             v_weekday_names[d + 1] AS label,
             date_trunc('week', v_local_now) + (d * interval '1 day') AS bstart,
             date_trunc('week', v_local_now) + ((d + 1) * interval '1 day') AS bend
      FROM generate_series(0, 6) AS d
    )
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('label', bk.label, 'orders', bk.orders,
                         'revenue', CASE WHEN v_full THEN bk.revenue ELSE NULL END)
      ORDER BY bk.ord
    ), '[]'::jsonb)
    INTO v_trend
    FROM (
      SELECT bk.ord, bk.label,
             COUNT(DISTINCT l.order_id) AS orders,
             COALESCE(SUM(l.line_total), 0) AS revenue
      FROM buckets bk
      LEFT JOIN lines l ON l.lt >= bk.bstart AND l.lt < bk.bend
      GROUP BY bk.ord, bk.label
    ) bk;

  ELSIF p_trend_mode = 'month' THEN
    WITH lines AS (
      SELECT b.order_id, b.line_total, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
      FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
    ),
    buckets AS (
      SELECT d AS ord,
             d::text AS label,
             date_trunc('month', v_local_now) + ((d - 1) * interval '1 day') AS bstart,
             date_trunc('month', v_local_now) + (d * interval '1 day') AS bend
      FROM generate_series(
        1,
        EXTRACT(DAY FROM (date_trunc('month', v_local_now) + interval '1 month' - interval '1 day'))::int
      ) AS d
    )
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('label', bk.label, 'orders', bk.orders,
                         'revenue', CASE WHEN v_full THEN bk.revenue ELSE NULL END)
      ORDER BY bk.ord
    ), '[]'::jsonb)
    INTO v_trend
    FROM (
      SELECT bk.ord, bk.label,
             COUNT(DISTINCT l.order_id) AS orders,
             COALESCE(SUM(l.line_total), 0) AS revenue
      FROM buckets bk
      LEFT JOIN lines l ON l.lt >= bk.bstart AND l.lt < bk.bend
      GROUP BY bk.ord, bk.label
    ) bk;

  ELSIF p_trend_mode = 'all' THEN
    SELECT date_trunc('month', MIN(lt))
    INTO v_first_month
    FROM (
      SELECT (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
      FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
    ) s;

    IF v_first_month IS NULL THEN
      v_trend := '[]'::jsonb;
    ELSE
      WITH lines AS (
        SELECT b.order_id, b.line_total, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
        FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
      ),
      buckets AS (
        SELECT g AS ord,
               v_month_names[EXTRACT(MONTH FROM mstart)::int] || ' ' || TO_CHAR(mstart, 'YY') AS label,
               mstart AS bstart,
               mstart + interval '1 month' AS bend
        FROM generate_series(
          0,
          (EXTRACT(YEAR FROM age(date_trunc('month', v_local_now), v_first_month)) * 12
            + EXTRACT(MONTH FROM age(date_trunc('month', v_local_now), v_first_month)))::int
        ) AS g,
        LATERAL (SELECT v_first_month + (g * interval '1 month') AS mstart) ms
      )
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('label', bk.label, 'orders', bk.orders,
                           'revenue', CASE WHEN v_full THEN bk.revenue ELSE NULL END)
        ORDER BY bk.ord
      ), '[]'::jsonb)
      INTO v_trend
      FROM (
        SELECT bk.ord, bk.label,
               COUNT(DISTINCT l.order_id) AS orders,
               COALESCE(SUM(l.line_total), 0) AS revenue
        FROM buckets bk
        LEFT JOIN lines l ON l.lt >= bk.bstart AND l.lt < bk.bend
        GROUP BY bk.ord, bk.label
      ) bk;
    END IF;

  ELSE -- 'custom'
    IF p_from IS NULL OR p_to IS NULL THEN
      v_trend := '[]'::jsonb;
    ELSE
      v_w_from := (p_from AT TIME ZONE 'UTC') - v_tz;
      v_w_to := (p_to AT TIME ZONE 'UTC') - v_tz;
      v_span_days := date_trunc('day', v_w_to)::date - date_trunc('day', v_w_from)::date + 1;

      IF v_span_days <= 62 THEN
        WITH lines AS (
          SELECT b.order_id, b.line_total, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
          FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
        ),
        buckets AS (
          SELECT d AS ord,
                 v_month_names[EXTRACT(MONTH FROM bstart)::int] || ' ' || EXTRACT(DAY FROM bstart)::int AS label,
                 bstart,
                 bstart + interval '1 day' AS bend
          FROM generate_series(0, v_span_days - 1) AS d,
               LATERAL (SELECT date_trunc('day', v_w_from) + (d * interval '1 day') AS bstart) bs
        )
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object('label', bk.label, 'orders', bk.orders,
                             'revenue', CASE WHEN v_full THEN bk.revenue ELSE NULL END)
          ORDER BY bk.ord
        ), '[]'::jsonb)
        INTO v_trend
        FROM (
          SELECT bk.ord, bk.label,
                 COUNT(DISTINCT l.order_id) AS orders,
                 COALESCE(SUM(l.line_total), 0) AS revenue
          FROM buckets bk
          LEFT JOIN lines l ON l.lt >= bk.bstart AND l.lt < bk.bend
          GROUP BY bk.ord, bk.label
        ) bk;
      ELSE
        WITH lines AS (
          SELECT b.order_id, b.line_total, (b.created_at AT TIME ZONE 'UTC') - v_tz AS lt
          FROM public._scoped_order_lines_base(v_tenant, v_branch_scoped, v_branch, NULL, NULL, NULL, NULL) b
        ),
        buckets AS (
          SELECT g AS ord,
                 v_month_names[EXTRACT(MONTH FROM mstart)::int] || ' ' || TO_CHAR(mstart, 'YY') AS label,
                 mstart AS bstart,
                 mstart + interval '1 month' AS bend
          FROM generate_series(
            0,
            (EXTRACT(YEAR FROM age(date_trunc('month', v_w_to), date_trunc('month', v_w_from))) * 12
              + EXTRACT(MONTH FROM age(date_trunc('month', v_w_to), date_trunc('month', v_w_from))))::int
          ) AS g,
          LATERAL (SELECT date_trunc('month', v_w_from) + (g * interval '1 month') AS mstart) ms
        )
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object('label', bk.label, 'orders', bk.orders,
                             'revenue', CASE WHEN v_full THEN bk.revenue ELSE NULL END)
          ORDER BY bk.ord
        ), '[]'::jsonb)
        INTO v_trend
        FROM (
          SELECT bk.ord, bk.label,
                 COUNT(DISTINCT l.order_id) AS orders,
                 COALESCE(SUM(l.line_total), 0) AS revenue
          FROM buckets bk
          LEFT JOIN lines l ON l.lt >= bk.bstart AND l.lt < bk.bend
          GROUP BY bk.ord, bk.label
        ) bk;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'current', v_current,
    'previous', v_previous,
    'product_ranks', v_product_ranks,
    'hot_week', v_hot_week,
    'hot_month', v_hot_month,
    'status_counts', v_status_counts,
    'weekday_counts', v_weekday_counts,
    'hour_counts', v_hour_counts,
    'monthly_repeat', v_monthly_repeat,
    'locations', v_locations,
    'trend', v_trend
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_scoped_order_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, int, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_scoped_order_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, int, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
