-- Timor Shop tenant admin migration
-- Run this in the Supabase SQL Editor after 002_admin_auth_rls.sql is in place.

-- 1. Allow the super-admin role in profiles and store email for tenant management UI.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('user', 'admin', 'super_admin'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email text;

-- 2. Track who owns each product so tenant admins can only manage their own items.
ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- 3. Helper: super admin only.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Helper: any admin (super admin or tenant admin).
-- This updates the existing is_admin() so current product/storage policies keep working
-- for the super admin after the role is renamed from 'admin' to 'super_admin'.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Backfill owner_id for existing products so the existing admin (now super admin)
--    still owns them. Products without an owner are treated as owned by the super admin.
DO $$
DECLARE
  super_admin_id uuid;
BEGIN
  SELECT id INTO super_admin_id FROM public.profiles WHERE role = 'super_admin' LIMIT 1;

  IF super_admin_id IS NULL THEN
    SELECT id INTO super_admin_id FROM public.profiles WHERE role = 'admin' LIMIT 1;
  END IF;

  IF super_admin_id IS NOT NULL THEN
    UPDATE public.products SET owner_id = super_admin_id WHERE owner_id IS NULL;
  END IF;
END $$;

-- 6. Update product policies for tenant ownership.
DROP POLICY IF EXISTS "Allow admin insert products" ON products;
DROP POLICY IF EXISTS "Allow admin update products" ON products;
DROP POLICY IF EXISTS "Allow admin delete products" ON products;

CREATE POLICY "Allow admin insert products" ON products
  FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY "Allow admin update products" ON products
  FOR UPDATE USING (public.is_super_admin() OR (public.is_admin() AND owner_id = auth.uid()));

CREATE POLICY "Allow admin delete products" ON products
  FOR DELETE USING (public.is_super_admin() OR (public.is_admin() AND owner_id = auth.uid()));

-- 7. Categories: only the super admin can add or remove them. Everyone can read.
DROP POLICY IF EXISTS "Allow admin insert categories" ON categories;
DROP POLICY IF EXISTS "Allow admin delete categories" ON categories;

CREATE POLICY "Allow super admin insert categories" ON categories
  FOR INSERT WITH CHECK (public.is_super_admin());

CREATE POLICY "Allow super admin delete categories" ON categories
  FOR DELETE USING (public.is_super_admin());

-- 8. Profiles: super admin can read/update/insert all profiles (needed for tenant management).
--    Users can still read their own profile.
DROP POLICY IF EXISTS "Allow admin read all profiles" ON profiles;
DROP POLICY IF EXISTS "Allow admin update profiles" ON profiles;

CREATE POLICY "Allow super admin read all profiles" ON profiles
  FOR SELECT USING (public.is_super_admin());

CREATE POLICY "Allow super admin update profiles" ON profiles
  FOR UPDATE USING (public.is_super_admin());

CREATE POLICY "Allow super admin insert profiles" ON profiles
  FOR INSERT WITH CHECK (public.is_super_admin());

CREATE POLICY "Allow super admin delete profiles" ON profiles
  FOR DELETE USING (public.is_super_admin());

-- 9. Storage: both super admin and tenant admins can upload/delete product images.
DROP POLICY IF EXISTS "Allow admin upload product images" ON storage.objects;
DROP POLICY IF EXISTS "Allow admin delete product images" ON storage.objects;

CREATE POLICY "Allow admin upload product images" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'product-images' AND public.is_admin());

CREATE POLICY "Allow admin delete product images" ON storage.objects
  FOR DELETE USING (bucket_id = 'product-images' AND public.is_admin());
