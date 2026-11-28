-- Timor Shop: order-line search matches variants + question labels (076).
-- Run after 075_product_visibility_toggle.sql.
--
-- The merged admin Orders page search (070/071) matched order code, phone,
-- location, product name, and checkout-question ANSWER values. Staff asked
-- to find orders by what the shopper actually picked: a variant option
-- (e.g. a bus route / fermata name stored in the line's selectedOptions)
-- and by checkout-question labels. Both live in the same items jsonb the
-- search already walks, so this is a pure widening of the search predicate
-- in _scoped_order_lines_base (the 071 shape, with product_id — plain
-- CREATE OR REPLACE, no drop). Same signature, same scoping, same
-- pagination, same callers (get_scoped_order_lines and get_scoped_order_stats
-- both ride this helper, so the Orders page, its .xlsx export, and Reports
-- period queries all pick the change up at once). Rows that matched before
-- still match.

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
    -- otherwise only lines matching on product name, variant group/option
    -- names (076 — e.g. a fermata/Size option), or checkout-question
    -- label/answer (076 added labels; 070 matched answer values only).
    AND (p_search IS NULL
         OR o.id ILIKE '%' || p_search || '%'
         OR o.phone_number ILIKE '%' || p_search || '%'
         OR COALESCE(o.location, '') ILIKE '%' || p_search || '%'
         OR it->'product'->>'name' ILIKE '%' || p_search || '%'
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(it->'selectedOptions', '[]'::jsonb)) AS so
           WHERE so->>'option' ILIKE '%' || p_search || '%'
              OR so->>'group' ILIKE '%' || p_search || '%'
         )
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(it->'fieldAnswers', '[]'::jsonb)) AS fa
           WHERE fa->>'value' ILIKE '%' || p_search || '%'
              OR fa->>'label' ILIKE '%' || p_search || '%'
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

NOTIFY pgrst, 'reload schema';
