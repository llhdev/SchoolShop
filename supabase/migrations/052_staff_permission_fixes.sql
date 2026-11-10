-- Timor Shop: close staff-era permission gaps (052).
-- Run after 051_fix_admin_set_password_search_path.sql.
--
-- Audit findings this fixes (server side):
--   1. 020's orders UPDATE policy let any tenant in tenant_ids write orders
--      directly, bypassing update_order_item_status (capability gates,
--      forward-only transitions, branch scope) — and 001's original
--      singular-named policies ("Allow admin update/delete orders",
--      is_admin() with no tenant check) were still live beside it, letting
--      ANY admin update or DELETE ANY order. Statuses only move through the
--      RPC now; update/delete are super-admin-only.
--   2. 040's payment_claims / payment_verifications SELECT policies and the
--      retry/approve RPCs predate staff accounts (auth.uid() never matches
--      tenant_id for staff), so financial staff were locked out of their own
--      pipeline while a capability-less owner could still act. Tenant checks
--      now use effective_tenant_id() and the actions require the Financial
--      capability.
--   3. The profiles guard trigger didn't protect the super-admin switches
--      is_active (037) and payment_verification_enabled (043) — the owner's
--      self-row UPDATE policy (050) could flip them.
--   4. The shop-settings RPCs (bank accounts, shipping fee, shop description,
--      telegram username) had no owner check; any staff account could call
--      them against its own row. Settings are owner-managed (048).
--   5. promote_staff_account accepted any caller-supplied branch_id,
--      including another shop's (branches are public-read).
--   6. product_files policies (044) predate the staff model: shop staff
--      couldn't manage PDFs on their shop's products while a capability-less
--      owner could. They now mirror 048's products policies.
--   7. is_active (037) was only enforced client-side; a still-valid JWT kept
--      writing. Products/product_files policies and update_order_item_status
--      now refuse writes for deactivated shops.

-- 1. Orders UPDATE: super admin only ------------------------------------------

DROP POLICY "Allow admins update orders" ON public.orders;
CREATE POLICY "Allow super admin update orders"
  ON public.orders FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- 001's original order policies used the singular "admin" in their names and
-- were never dropped by 012/020, so they lived on next to the replacements:
-- ANY admin could UPDATE (and DELETE!) ANY order regardless of tenant. Remove
-- them; deletion becomes super-admin-only (cancelled orders are kept, never
-- deleted).
DROP POLICY IF EXISTS "Allow admin update orders" ON public.orders;
DROP POLICY IF EXISTS "Allow admin delete orders" ON public.orders;
CREATE POLICY "Allow super admin delete orders"
  ON public.orders FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- 2. Verification rows readable by the shop's staff ----------------------------

DROP POLICY "Admins read payment claims" ON public.payment_claims;
CREATE POLICY "Admins read payment claims"
  ON public.payment_claims FOR SELECT TO authenticated
  USING (public.is_super_admin() OR tenant_id = public.effective_tenant_id());

DROP POLICY "Admins read payment verifications" ON public.payment_verifications;
CREATE POLICY "Admins read payment verifications"
  ON public.payment_verifications FOR SELECT TO authenticated
  USING (public.is_super_admin() OR tenant_id = public.effective_tenant_id());

-- 3. Financial capability gates the verification actions -----------------------

CREATE OR REPLACE FUNCTION public.has_financial_capability()
RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT p.staff_financial FROM public.profiles p WHERE p.id = auth.uid()),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.retry_payment_verification(
  p_order_id text,
  p_tenant_id uuid
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() AND NOT (
    public.effective_tenant_id() = p_tenant_id
    AND public.has_financial_capability()
  ) THEN
    RAISE EXCEPTION 'Only the super admin or the shop''s financial admin can retry verification.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = p_order_id AND payment_proofs ? p_tenant_id::text
  ) THEN
    RAISE EXCEPTION 'Order not found, or it has no payment proof for this tenant.';
  END IF;
  PERFORM public.request_payment_verification(p_order_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.approve_payment_verification(
  p_order_id text,
  p_tenant_id uuid
)
RETURNS void AS $$
DECLARE
  v public.payment_verifications%ROWTYPE;
  claimed_order text;
BEGIN
  IF NOT public.is_super_admin() AND NOT (
    public.effective_tenant_id() = p_tenant_id
    AND public.has_financial_capability()
  ) THEN
    RAISE EXCEPTION 'Only the super admin or the shop''s financial admin can approve a payment.';
  END IF;

  SELECT * INTO v FROM public.payment_verifications
  WHERE order_id = p_order_id AND tenant_id = p_tenant_id AND is_current
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No verification found for this order and tenant.';
  END IF;
  IF v.status = 'verified' THEN
    RETURN; -- already approved/verified; idempotent
  END IF;
  IF v.status <> 'needs_review' THEN
    RAISE EXCEPTION 'Only payments flagged for review can be approved (current status: %).', v.status;
  END IF;

  -- Manual approval must also prevent duplicate use: claim the reference
  -- atomically, rejecting if another order got there first.
  IF v.provider IS NOT NULL AND v.reference IS NOT NULL THEN
    INSERT INTO public.payment_claims (provider, reference, order_id, tenant_id, verification_id)
    VALUES (v.provider, v.reference, p_order_id, p_tenant_id, v.id)
    ON CONFLICT (provider, reference) DO NOTHING
    RETURNING order_id INTO claimed_order;

    IF claimed_order IS NULL THEN
      SELECT order_id INTO claimed_order FROM public.payment_claims
      WHERE provider = v.provider AND reference = v.reference;
      IF claimed_order IS DISTINCT FROM p_order_id THEN
        RAISE EXCEPTION 'This transaction was already claimed by order %.', claimed_order;
      END IF;
    END IF;
  END IF;

  UPDATE public.payment_verifications
  SET status = 'verified',
      checks = checks || jsonb_build_object(
        'notPreviouslyClaimed', jsonb_build_object('result', 'pass', 'reason', 'claimed on manual approval'),
        'manualApproval', jsonb_build_object('result', 'pass', 'reason', 'approved by merchant')
      ),
      updated_at = now()
  WHERE id = v.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Guard trigger: super-admin-only switches ----------------------------------
--
-- Same as 048, plus: is_active (037) and payment_verification_enabled (043)
-- are super-admin switches — the owner's self-row UPDATE policy (050) must not
-- flip them. branch_selection_enabled is deliberately NOT protected: branch
-- dropdown visibility is the shop's own decision.
-- (The early return keeps the super admin and service role unrestricted.)

CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns()
RETURNS trigger AS $$
DECLARE
  v_is_owner boolean;
  v_is_promotion boolean;
BEGIN
  IF auth.uid() IS NULL OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  v_is_owner := public.is_shop_owner();
  v_is_promotion := v_is_owner
    AND OLD.role = 'user' AND OLD.parent_tenant_id IS NULL
    AND NEW.role = 'admin' AND NEW.parent_tenant_id = auth.uid();

  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.email IS DISTINCT FROM OLD.email THEN
    IF NOT (v_is_promotion AND NEW.email IS NOT DISTINCT FROM OLD.email) THEN
      RAISE EXCEPTION 'Only the super admin can change a profile role or email.';
    END IF;
  END IF;

  IF NEW.parent_tenant_id IS DISTINCT FROM OLD.parent_tenant_id
     OR NEW.staff_financial IS DISTINCT FROM OLD.staff_financial
     OR NEW.staff_shop IS DISTINCT FROM OLD.staff_shop
     OR NEW.staff_branch IS DISTINCT FROM OLD.staff_branch
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.staff_label IS DISTINCT FROM OLD.staff_label
  THEN
    IF NOT (
      v_is_owner AND (
        v_is_promotion
        OR OLD.parent_tenant_id = auth.uid()
        OR (NEW.id = auth.uid()
            AND NEW.parent_tenant_id IS NOT DISTINCT FROM OLD.parent_tenant_id
            AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id
            AND NEW.staff_label IS NOT DISTINCT FROM OLD.staff_label)
      )
    ) THEN
      RAISE EXCEPTION 'Only the super admin or the shop owner can change staff columns.';
    END IF;
  END IF;

  IF NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.payment_verification_enabled IS DISTINCT FROM OLD.payment_verification_enabled THEN
    RAISE EXCEPTION 'Only the super admin can change shop activation or payment-verification switches.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5. Shop settings RPCs are owner-only -----------------------------------------

CREATE OR REPLACE FUNCTION public.update_own_bank_accounts(p_accounts jsonb)
RETURNS void AS $$
BEGIN
  IF NOT public.is_shop_owner() THEN
    RAISE EXCEPTION 'Only the shop owner can change shop settings.';
  END IF;

  UPDATE public.profiles
  SET bank_accounts = COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'account_number', trim(elem->>'account_number'),
                   'bank_name', NULLIF(trim(elem->>'bank_name'), ''),
                   'qr_image_url', NULLIF(trim(elem->>'qr_image_url'), '')
                 )
               )
        FROM jsonb_array_elements(COALESCE(p_accounts, '[]'::jsonb)) AS elem
        WHERE NULLIF(trim(elem->>'account_number'), '') IS NOT NULL
      ), '[]'::jsonb)
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_own_shipping_fee(p_fee numeric)
RETURNS void AS $$
BEGIN
  IF NOT public.is_shop_owner() THEN
    RAISE EXCEPTION 'Only the shop owner can change shop settings.';
  END IF;

  IF p_fee IS NOT NULL AND p_fee < 0 THEN
    RAISE EXCEPTION 'Shipping fee cannot be negative.';
  END IF;

  UPDATE public.profiles
  SET shipping_fee = CASE WHEN p_fee IS NULL OR p_fee <= 0 THEN NULL ELSE p_fee END
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_own_shop_description(
  p_description text
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_shop_owner() THEN
    RAISE EXCEPTION 'Only the shop owner can change shop settings.';
  END IF;

  UPDATE public.profiles
  SET shop_description = nullif(trim(p_description), '')
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_own_telegram_username(
  p_username text
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_shop_owner() THEN
    RAISE EXCEPTION 'Only the shop owner can change shop settings.';
  END IF;

  UPDATE public.profiles
  SET telegram_username = nullif(trim(both '@' from trim(p_username)), '')
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6. promote_staff_account: validate the branch belongs to the shop ------------

CREATE OR REPLACE FUNCTION public.promote_staff_account(
  p_staff_id uuid,
  p_tenant_id uuid,
  p_label text,
  p_financial boolean,
  p_shop boolean,
  p_branch boolean,
  p_branch_id uuid
)
RETURNS void AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF public.is_super_admin() THEN
    v_tenant := p_tenant_id;
  ELSIF public.is_shop_owner() THEN
    -- Owners can only build their own shop's staff.
    v_tenant := auth.uid();
  ELSE
    RAISE EXCEPTION 'Only the super admin or the shop owner can create staff accounts.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_tenant AND role = 'admin' AND parent_tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Shop not found.';
  END IF;

  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = p_branch_id AND tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'Branch not found in this shop.';
  END IF;

  UPDATE public.profiles
  SET role = 'admin',
      parent_tenant_id = v_tenant,
      staff_financial = p_financial,
      staff_shop = p_shop,
      staff_branch = p_branch,
      branch_id = p_branch_id,
      staff_label = NULLIF(trim(p_label), '')
  WHERE id = p_staff_id
    AND role = 'user'
    AND parent_tenant_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff account not found or already assigned.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 7. Deactivated shops cannot write --------------------------------------------

CREATE OR REPLACE FUNCTION public.is_shop_active(p_tenant uuid)
RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT p.is_active FROM public.profiles p WHERE p.id = p_tenant),
    true
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 8. product_files: mirror 048's products policies (tenancy + Shop capability) --
--    (also picks up the is_shop_active write guard)

DROP POLICY "Admins read own product files" ON public.product_files;
CREATE POLICY "Admins read own product files" ON public.product_files
  FOR SELECT USING (
    public.is_super_admin() OR (
      public.is_admin() AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id
          AND p.owner_id = public.effective_tenant_id()
      )
    )
  );

DROP POLICY "Admins insert own product files" ON public.product_files;
CREATE POLICY "Admins insert own product files" ON public.product_files
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR (
      public.is_admin()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
      AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id
          AND p.owner_id = public.effective_tenant_id()
      )
    )
  );

DROP POLICY "Admins update own product files" ON public.product_files;
CREATE POLICY "Admins update own product files" ON public.product_files
  FOR UPDATE USING (
    public.is_super_admin() OR (
      public.is_admin()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
      AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id
          AND p.owner_id = public.effective_tenant_id()
      )
    )
  ) WITH CHECK (
    public.is_super_admin() OR (
      public.is_admin()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
      AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id
          AND p.owner_id = public.effective_tenant_id()
      )
    )
  );

DROP POLICY "Admins delete own product files" ON public.product_files;
CREATE POLICY "Admins delete own product files" ON public.product_files
  FOR DELETE USING (
    public.is_super_admin() OR (
      public.is_admin()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
      AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id
          AND p.owner_id = public.effective_tenant_id()
      )
    )
  );

-- 9. Products policies: add the is_shop_active write guard ----------------------

DROP POLICY "Allow admin insert products" ON public.products;
CREATE POLICY "Allow admin insert products" ON public.products
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR (
      public.is_admin()
      AND owner_id = public.effective_tenant_id()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
    )
  );

DROP POLICY "Allow admin update products" ON public.products;
CREATE POLICY "Allow admin update products" ON public.products
  FOR UPDATE USING (
    public.is_super_admin()
    OR (
      public.is_admin()
      AND owner_id = public.effective_tenant_id()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
    )
  ) WITH CHECK (
    public.is_super_admin()
    OR (
      public.is_admin()
      AND owner_id = public.effective_tenant_id()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
    )
  );

DROP POLICY "Allow admin delete products" ON public.products;
CREATE POLICY "Allow admin delete products" ON public.products
  FOR DELETE USING (
    public.is_super_admin()
    OR (
      public.is_admin()
      AND owner_id = public.effective_tenant_id()
      AND public.has_shop_capability()
      AND public.is_shop_active(public.effective_tenant_id())
    )
  );

-- 10. update_order_item_status: refuse writes for deactivated shops -------------
--
-- Same as 047, plus one check: a non-super-admin caller cannot move items of a
-- shop whose is_active is off (037).

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
  -- (server-stamped owner_id, camelCase fallback) and, for branch-scoped
  -- staff while branch selection is on, carry their branch stamp.
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
