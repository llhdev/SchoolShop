-- Timor Shop admin auth + RLS migration
-- Run this in the Supabase SQL Editor after the initial schema is in place.

-- Profiles table: maps auth users to roles.
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz DEFAULT now()
);

-- Auto-create a profile for every new auth user.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, role)
  VALUES (new.id, 'user');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Helper used by RLS policies to check admin role.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Enable RLS on profiles (only admins should read/write other profiles).
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Drop old public policies from the initial migration.
DROP POLICY IF EXISTS "Allow public read products" ON products;
DROP POLICY IF EXISTS "Allow public insert products" ON products;
DROP POLICY IF EXISTS "Allow public update products" ON products;
DROP POLICY IF EXISTS "Allow public delete products" ON products;

DROP POLICY IF EXISTS "Allow public read orders" ON orders;
DROP POLICY IF EXISTS "Allow public insert orders" ON orders;
DROP POLICY IF EXISTS "Allow public delete orders" ON orders;

DROP POLICY IF EXISTS "Allow public read categories" ON categories;
DROP POLICY IF EXISTS "Allow public insert categories" ON categories;
DROP POLICY IF EXISTS "Allow public delete categories" ON categories;

DROP POLICY IF EXISTS "Allow public upload product images" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read product images" ON storage.objects;
DROP POLICY IF EXISTS "Allow public delete product images" ON storage.objects;

-- Products: public read, admin write.
CREATE POLICY "Allow public read products" ON products FOR SELECT USING (true);
CREATE POLICY "Allow admin insert products" ON products FOR INSERT WITH CHECK (public.is_admin());
CREATE POLICY "Allow admin update products" ON products FOR UPDATE USING (public.is_admin());
CREATE POLICY "Allow admin delete products" ON products FOR DELETE USING (public.is_admin());

-- Categories: public read, admin write.
CREATE POLICY "Allow public read categories" ON categories FOR SELECT USING (true);
CREATE POLICY "Allow admin insert categories" ON categories FOR INSERT WITH CHECK (public.is_admin());
CREATE POLICY "Allow admin delete categories" ON categories FOR DELETE USING (public.is_admin());

-- Orders: public insert so checkout works without shopper auth; admin read/update/delete.
CREATE POLICY "Allow admin read orders" ON orders FOR SELECT USING (public.is_admin());
CREATE POLICY "Allow public insert orders" ON orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow admin update orders" ON orders FOR UPDATE USING (public.is_admin());
CREATE POLICY "Allow admin delete orders" ON orders FOR DELETE USING (public.is_admin());

-- Profiles: users can read their own profile; admins can read all profiles.
CREATE POLICY "Allow users read own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Allow admin read all profiles" ON profiles FOR SELECT USING (public.is_admin());
CREATE POLICY "Allow admin update profiles" ON profiles FOR UPDATE USING (public.is_admin());

-- Storage: public read for product images; admin upload/delete.
CREATE POLICY "Allow public read product images" ON storage.objects
  FOR SELECT USING (bucket_id = 'product-images');
CREATE POLICY "Allow admin upload product images" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'product-images' AND public.is_admin());
CREATE POLICY "Allow admin delete product images" ON storage.objects
  FOR DELETE USING (bucket_id = 'product-images' AND public.is_admin());
