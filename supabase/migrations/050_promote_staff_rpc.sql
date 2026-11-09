-- Timor Shop: promote a fresh signup to staff via RPC (050).
-- Run after 049_owner_profiles_update_policy.sql.
--
-- Why: 049's owner UPDATE policy still couldn't promote a fresh signup —
-- Postgres only lets UPDATE touch rows that are also SELECT-visible, and a
-- brand-new 'user' profile is invisible to the shop owner (SELECT policies
-- cover only the owner's own row and the shop's existing rows). The update
-- silently matched zero rows, so "add staff" failed for owners.
--
-- Fix: a SECURITY DEFINER RPC does the promotion (bypasses RLS; the 048
-- guard trigger still validates the promotion shape), and the 049 policy
-- drops its loose role='user' clause — owners now update only their own row
-- and their own staff's rows.

-- 1. Promotion RPC --------------------------------------------------------------
--
-- Called right after the secondary-client signup in createStaffAccount. The
-- caller must be the super admin or an active shop owner; the target must be
-- a fresh, unaffiliated 'user' profile. A one-man shop keeps staff creation
-- working without ever seeing other users' rows.

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

GRANT EXECUTE ON FUNCTION public.promote_staff_account(uuid, uuid, text, boolean, boolean, boolean, uuid) TO authenticated;

-- 2. Tighten the 049 owner UPDATE policy -----------------------------------------
--
-- The promotion no longer goes through RLS, so the role='user' clause is
-- removed: owners can update only their own row and their own staff's rows.

DROP POLICY "Allow owner manage shop profiles" ON public.profiles;
CREATE POLICY "Allow owner manage shop profiles" ON public.profiles
  FOR UPDATE USING (
    public.is_shop_owner()
    AND (id = auth.uid() OR parent_tenant_id = auth.uid())
  ) WITH CHECK (
    public.is_shop_owner()
    AND (id = auth.uid() OR parent_tenant_id = auth.uid())
  );
