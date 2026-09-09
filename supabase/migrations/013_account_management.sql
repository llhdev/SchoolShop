-- Timor Shop account management migration
-- Run this in the Supabase SQL Editor after 012_order_status_update.sql.
-- Adds: self-service username change, super-admin tenant account editing,
-- and a guard so non-super-admins can no longer rewrite profile role/email.

-- 1. Self-service: an admin changes their own login username (gateway).
--    Only the caller's own row is touched, so a tenant cannot affect anyone else.
CREATE OR REPLACE FUNCTION public.change_own_username(new_username text)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET username = lower(trim(new_username))
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. Super admin edits a tenant's account details.
--    Updates both profiles and the underlying auth.users email so login keeps working.
CREATE OR REPLACE FUNCTION public.admin_update_tenant(
  tenant_id uuid,
  new_username text,
  new_email text,
  new_shop_name text
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only the super admin can edit tenant accounts.';
  END IF;

  UPDATE public.profiles
  SET username = lower(trim(new_username)),
      email = lower(trim(new_email)),
      shop_name = trim(new_shop_name)
  WHERE id = tenant_id AND role = 'admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found.';
  END IF;

  UPDATE auth.users
  SET email = lower(trim(new_email))
  WHERE id = tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. Super admin sets a tenant's password. pgcrypto ships with Supabase;
--    the bcrypt hash is written directly to auth.users.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.admin_set_tenant_password(
  tenant_id uuid,
  new_password text
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only the super admin can set tenant passwords.';
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

-- 4. Guard: a non-super-admin (with a real auth.uid) must not be able to change
--    a profile's role or email. Service-role calls (auth.uid() IS NULL, e.g. the
--    setup script and Edge Functions) pass through. Tenant creation is unaffected
--    because the role is set by the INSERT trigger, not an UPDATE.
CREATE OR REPLACE FUNCTION public.protect_profile_role_and_email()
RETURNS trigger AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.is_super_admin()
     AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.email IS DISTINCT FROM OLD.email)
  THEN
    RAISE EXCEPTION 'Only the super admin can change a profile role or email.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_profile_role_and_email ON public.profiles;
CREATE TRIGGER protect_profile_role_and_email
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_role_and_email();

-- 5. Allow signed-in admins to call the account functions.
GRANT EXECUTE ON FUNCTION public.change_own_username(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_tenant(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_tenant_password(uuid, text) TO authenticated;
