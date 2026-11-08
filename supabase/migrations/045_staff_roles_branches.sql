-- Timor Shop: per-tenant staff roles (financial / shop / branch), shop
-- branches, and the new order lifecycle.
-- Run after 044_product_files.sql.
--
-- New lifecycle: pending -> received (branch staff) -> paid (financial staff)
-- -> on_the_way (branch) -> completed (branch), plus cancelled (branch, from
-- pending/received only). Old 'paid' meant "Order Received", so existing
-- 'paid' orders/items backfill to 'received'.
--
-- Staff accounts are extra auth users with role='admin' and
-- profiles.parent_tenant_id pointing at the shop owner. The owner keeps
-- parent_tenant_id NULL and all three capabilities (backfilled below), which
-- is the old full tenant admin. All scoping uses effective_tenant_id() =
-- COALESCE(parent_tenant_id, auth.uid()).
--
-- Branches live in a new table (public read for anon checkout, super-admin
-- write). Order items carry branchId/branchName; stamp_order_tenants
-- re-validates the branch against the item's owner (clients are untrusted).

-- 1. Branches ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  delivery_location text,
  phone text,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

-- Anon shoppers read branches at checkout; only the super admin manages them.
CREATE POLICY "Allow public read branches" ON public.branches
  FOR SELECT USING (true);
CREATE POLICY "Allow super admin manage branches" ON public.branches
  FOR ALL USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- 2. Staff columns on profiles ----------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS parent_tenant_id uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS staff_financial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS staff_shop boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS staff_branch boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_label text;

-- Existing tenant owners (and future ones, set by the app at creation) hold
-- all three capabilities = the old full tenant admin.
UPDATE public.profiles
SET staff_financial = true, staff_shop = true, staff_branch = true
WHERE role = 'admin' AND parent_tenant_id IS NULL;

-- 3. Helpers ------------------------------------------------------------------

-- The shop a caller acts for: themselves, or their parent tenant when staff.
CREATE OR REPLACE FUNCTION public.effective_tenant_id()
RETURNS uuid AS $$
  SELECT COALESCE(
    (SELECT p.parent_tenant_id FROM public.profiles p WHERE p.id = auth.uid()),
    auth.uid()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 4. New order statuses -------------------------------------------------------

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;

UPDATE public.orders SET status = 'received' WHERE status = 'paid';

UPDATE public.orders
SET item_statuses = (
  SELECT jsonb_object_agg(
    e.key,
    CASE WHEN e.value #>> '{}' = 'paid' THEN to_jsonb('received'::text) ELSE e.value END
  )
  FROM jsonb_each(item_statuses) AS e
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_each_text(item_statuses) AS t WHERE t.value = 'paid'
);

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'received', 'paid', 'on_the_way', 'completed', 'cancelled'));

-- 5. update_order_item_status: capabilities, transitions, branch scope --------
--
-- Supersedes 039. Adds:
--   * capability gates (financial marks paid; branch marks received/shipped/
--     completed/cancelled; super admin anything),
--   * forward-only transitions for non-super-admins,
--   * branch-scoped staff only touch items stamped with their branch,
--   * cancelled-aware order recompute (least-advanced NON-cancelled item;
--     all items cancelled => order cancelled).
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

  IF NOT public.is_super_admin() THEN
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
  -- (server-stamped owner_id, camelCase fallback) and, for branch-scoped
  -- staff, carry their branch stamp.
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
        AND (v_branch IS NULL OR keyed.it->>'branchId' = v_branch::text)
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

GRANT EXECUTE ON FUNCTION public.update_order_item_status(text, text, text) TO authenticated;

-- 6. stamp_order_tenants: validate + stamp branch per item --------------------
--
-- Same contract as 019 (owner_id/shop_name onto each item's product, fill
-- tenant_ids), plus: a client-supplied item branchId is kept only when it is
-- a real branch of that item's owner — then branchName is stamped
-- server-side; otherwise both keys are stripped.
CREATE OR REPLACE FUNCTION public.stamp_order_tenants()
RETURNS trigger AS $$
BEGIN
  NEW.tenant_ids := COALESCE((
    SELECT array_agg(DISTINCT p.owner_id)
    FROM public.products p
    WHERE p.owner_id IS NOT NULL
      AND p.id IN (
        SELECT elem->'product'->>'id'
        FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
        WHERE elem->'product'->>'id' IS NOT NULL
      )
  ), '{}');

  NEW.items := COALESCE((
    SELECT jsonb_agg(
      CASE
        WHEN elem->'product'->>'id' IS NULL THEN elem
        WHEN b.id IS NOT NULL THEN
          jsonb_set(
            jsonb_set(base.it, '{branchId}', to_jsonb(b.id::text)),
            '{branchName}', to_jsonb(b.name))
        ELSE base.it - 'branchId' - 'branchName'
      END
    )
    FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) AS elem
    LEFT JOIN public.products p ON p.id = elem->'product'->>'id'
    LEFT JOIN public.profiles pr ON pr.id = p.owner_id
    LEFT JOIN public.branches b
      ON b.id::text = elem->>'branchId' AND b.tenant_id = p.owner_id
    CROSS JOIN LATERAL (
      SELECT jsonb_set(
               jsonb_set(elem, '{product,owner_id}',
                 to_jsonb(COALESCE(p.owner_id::text, ''))),
               '{product,shop_name}',
               to_jsonb(COALESCE(pr.shop_name, ''))
             ) AS it
    ) AS base
  ), '[]'::jsonb);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 7. Products RLS: staff manage the shop's catalog ----------------------------

DROP POLICY "Allow admin update products" ON public.products;
CREATE POLICY "Allow admin update products" ON public.products
  FOR UPDATE USING (
    public.is_super_admin()
    OR (public.is_admin() AND owner_id = public.effective_tenant_id())
  );

DROP POLICY "Allow admin delete products" ON public.products;
CREATE POLICY "Allow admin delete products" ON public.products
  FOR DELETE USING (
    public.is_super_admin()
    OR (public.is_admin() AND owner_id = public.effective_tenant_id())
  );

-- 8. Gateway lookup: one username, many staff accounts ------------------------
--
-- The home-search gateway resolves a shop username to ALL its login accounts
-- (owner + staff). The login screen tries each email with the typed password;
-- the password picks the account. Inactive shops expose nothing.
CREATE OR REPLACE FUNCTION public.get_accounts_by_username(username text)
RETURNS TABLE(email text) AS $$
DECLARE
  v_owner public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_owner
  FROM public.profiles p
  WHERE p.username = get_accounts_by_username.username
    AND p.role IN ('admin', 'super_admin')
  LIMIT 1;

  IF NOT FOUND OR NOT v_owner.is_active THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT v_owner.email WHERE v_owner.email IS NOT NULL
  UNION ALL
  SELECT p.email FROM public.profiles p
  WHERE p.parent_tenant_id = v_owner.id AND p.email IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_accounts_by_username(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_accounts_by_username(text) TO authenticated;

-- 9. Delete a staff account (products and orders are untouched) ---------------

CREATE OR REPLACE FUNCTION public.admin_delete_staff(staff_id uuid)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only the super admin can delete staff accounts.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = staff_id AND parent_tenant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Staff account not found.';
  END IF;

  DELETE FROM auth.users WHERE id = staff_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.admin_delete_staff(uuid) TO authenticated;
