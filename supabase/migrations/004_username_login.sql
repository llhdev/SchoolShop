-- OnlineShop username-based admin login migration
-- Run this in the Supabase SQL Editor after 003_tenant_admins.sql is in place.

-- 1. Store a human-friendly username for each admin. The username is typed into
--    the home search bar to open the admin login screen.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username text UNIQUE;

-- 2. Backfill the super admin username. Adjust the WHERE clause if your super admin
--    uses a different email; the default matches the setup-admin script defaults.
UPDATE public.profiles
SET username = 'santa2024'
WHERE role = 'super_admin' AND username IS NULL;

-- 3. Public lookup: given a username, return the email and role so the app can
--    route to the correct admin login. This does not expose a list of admins;
--    it only returns data for an exact username match.
CREATE OR REPLACE FUNCTION public.get_admin_by_username(username text)
RETURNS TABLE(email text, role text) AS $$
BEGIN
  RETURN QUERY
  SELECT p.email, p.role
  FROM public.profiles p
  WHERE p.username = get_admin_by_username.username
    AND p.role IN ('admin', 'super_admin')
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Allow anonymous and authenticated users to call the lookup function.
GRANT EXECUTE ON FUNCTION public.get_admin_by_username(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_admin_by_username(text) TO authenticated;
