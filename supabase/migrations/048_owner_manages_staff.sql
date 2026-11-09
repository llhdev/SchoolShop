-- Timor Shop: the shop owner manages its own staff (048).
-- Run after 047_branch_scope_toggle.sql.
--
-- The owner account becomes management-only by default: it creates/edits/
-- removes the shop's staff accounts (financial / shop / branch admins) and
-- manages shop-level settings, but does no operational work (products, order
-- statuses, money, proofs) unless it turns on its own capability toggles via
-- update_own_capabilities — a one-man shop flips all three on and behaves
-- like the old full tenant admin. Existing owners keep the all-true toggles
-- backfilled by 045 (grandfathered); tenants created after this migration
-- start with all three off. One owner per shop; super admin unchanged.
--
-- This migration also closes a hole: 002's "Allow admin update profiles"
-- policy lets ANY admin update ANY profile row, so a staff account could
-- flip its own staff_* columns. The rewritten guard trigger now protects the
-- staff columns the same way 013 protected role/email.

-- 1. Helper: caller is an active shop owner -----------------------------------

CREATE OR REPLACE FUNCTION public.is_shop_owner()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
      AND p.parent_tenant_id IS NULL
      AND COALESCE(p.is_active, true)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 2. Helper: caller holds the Shop capability ---------------------------------

CREATE OR REPLACE FUNCTION public.has_shop_capability()
RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT p.staff_shop FROM public.profiles p WHERE p.id = auth.uid()),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 3. Guard trigger: role/email + staff columns --------------------------------
--
-- Replaces 013's protect_profile_role_and_email. Non-super-admins may not
-- change role/email, and may not change the staff columns
-- (parent_tenant_id, staff_*, branch_id, staff_label) unless the caller is an
-- active shop owner AND one of:
--   * promotion — a fresh signup (role 'user', no parent) becomes staff of
--     the caller's own shop (NEW.parent_tenant_id = auth.uid()),
--   * the target is the caller's staff (OLD.parent_tenant_id = auth.uid()),
--   * the target is the caller and only the three staff_* booleans changed
--     (owner self-toggle).
-- Service-role calls (auth.uid() IS NULL) and the super admin pass through.

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_profile_role_and_email ON public.profiles;
DROP TRIGGER IF EXISTS protect_profile_privileged_columns ON public.profiles;
CREATE TRIGGER protect_profile_privileged_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_columns();

DROP FUNCTION IF EXISTS public.protect_profile_role_and_email();

-- 4. Owner deletes its own shop's staff ---------------------------------------

CREATE OR REPLACE FUNCTION public.admin_delete_staff(staff_id uuid)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    IF NOT (
      public.is_shop_owner()
      AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = staff_id AND parent_tenant_id = auth.uid()
      )
    ) THEN
      RAISE EXCEPTION 'Only the super admin or the shop owner can delete staff accounts.';
    END IF;
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

-- 5. Owner resets its own staff's passwords ------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_tenant_password(
  tenant_id uuid,
  new_password text
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    IF NOT (
      public.is_shop_owner()
      AND EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = tenant_id AND parent_tenant_id = auth.uid()
      )
    ) THEN
      RAISE EXCEPTION 'Only the super admin or the shop owner can set account passwords.';
    END IF;
  END IF;

  IF length(new_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters.';
  END IF;

  UPDATE auth.users
  SET encrypted_password = crypt(new_password, gen_salt('bf'))
  WHERE id = tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6. Owner self-service capability toggles -------------------------------------
--
-- Owners flip their own Financial/Shop/Branch toggles. All off = pure
-- manager (the default for new shops); all on = the old full tenant admin.
-- A Branch toggle on the owner grants shop-wide branch powers (no branch is
-- created — branches belong to branch-admin staff accounts, migration 046).

CREATE OR REPLACE FUNCTION public.update_own_capabilities(
  p_financial boolean,
  p_shop boolean,
  p_branch boolean
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_shop_owner() THEN
    RAISE EXCEPTION 'Only a shop owner can change their own capabilities.';
  END IF;

  UPDATE public.profiles
  SET staff_financial = p_financial,
      staff_shop = p_shop,
      staff_branch = p_branch
  WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.update_own_capabilities(boolean, boolean, boolean) TO authenticated;

-- 7. Branches RLS: the owner manages its own shop's branches -------------------
--
-- createBranch/renameBranch/deleteBranch are direct table ops; 045 allowed
-- only the super admin. The owner needs them because branches are created/
-- renamed/deleted as a side effect of managing branch-admin staff (046).
-- tenant_id = auth.uid() matches the owner only — a staff account's uid is
-- never the shop's tenant id.

CREATE POLICY "Allow owner manage own branches" ON public.branches
  FOR ALL USING (tenant_id = auth.uid() AND public.is_shop_owner())
  WITH CHECK (tenant_id = auth.uid() AND public.is_shop_owner());

-- 8. Products RLS: the Shop capability is enforced server-side -----------------
--
-- Until now any admin of the tenant could write products regardless of the
-- staff_shop toggle. The non-super-admin path now requires the capability.

DROP POLICY "Allow admin insert products" ON public.products;
CREATE POLICY "Allow admin insert products" ON public.products
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR (
      public.is_admin()
      AND owner_id = public.effective_tenant_id()
      AND public.has_shop_capability()
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
    )
  ) WITH CHECK (
    public.is_super_admin()
    OR (
      public.is_admin()
      AND owner_id = public.effective_tenant_id()
      AND public.has_shop_capability()
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
    )
  );
