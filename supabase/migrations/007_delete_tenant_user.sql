-- Timor Shop tenant deletion migration
-- Allows a super admin to permanently delete a tenant account from auth.users.
-- The matching public.profiles row is removed automatically via ON DELETE CASCADE.

CREATE OR REPLACE FUNCTION public.delete_tenant_user(tenant_id uuid)
RETURNS void AS $$
BEGIN
  -- Only super admins can delete tenant accounts.
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only super admins can delete tenant accounts';
  END IF;

  -- Prevent deleting the super admin account through this function.
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = tenant_id AND role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'Cannot delete the super admin account';
  END IF;

  -- Delete the auth user; the profile is removed via ON DELETE CASCADE.
  DELETE FROM auth.users WHERE id = tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.delete_tenant_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_tenant_user(uuid) TO anon;
