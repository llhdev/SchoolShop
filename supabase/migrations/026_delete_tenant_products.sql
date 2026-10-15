-- Timor Shop tenant deletion: also remove the tenant's products
-- Deleting a tenant now removes every product they uploaded from the platform,
-- so a removed shop's catalog disappears together with its account.

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

  -- Remove the tenant's products so they leave the platform too.
  -- (Storage image objects are left orphaned, as with in-app product deletion.)
  DELETE FROM public.products WHERE owner_id = tenant_id;

  -- Delete the auth user; the profile is removed via ON DELETE CASCADE.
  DELETE FROM auth.users WHERE id = tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.delete_tenant_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_tenant_user(uuid) TO anon;
