-- Timor Shop: fix admin_set_tenant_password search_path (051).
-- Run after 050_promote_staff_rpc.sql.
--
-- 013's function sets search_path = public, but pgcrypto (gen_salt/crypt)
-- lives in the extensions schema — so every call failed with
-- "function gen_salt(unknown) does not exist". Recreated with the extensions
-- schema on the path. Logic unchanged from 048 (super admin, or the shop
-- owner for its own staff).

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;
