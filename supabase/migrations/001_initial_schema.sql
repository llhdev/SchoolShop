-- Timor Shop initial Supabase schema
-- Run this in the Supabase SQL Editor after creating your project.

-- Products
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price numeric NOT NULL,
  category text NOT NULL,
  images text[] NOT NULL DEFAULT '{}',
  cover_image_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  items jsonb NOT NULL DEFAULT '[]',
  total numeric NOT NULL,
  payment_method text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  location text NOT NULL,
  phone_number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  name text PRIMARY KEY
);

-- Row Level Security
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

-- Public policies for the MVP (lock down when auth is added)
CREATE POLICY "Allow public read products" ON products FOR SELECT USING (true);
CREATE POLICY "Allow public insert products" ON products FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update products" ON products FOR UPDATE USING (true);
CREATE POLICY "Allow public delete products" ON products FOR DELETE USING (true);

CREATE POLICY "Allow public read orders" ON orders FOR SELECT USING (true);
CREATE POLICY "Allow public insert orders" ON orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public delete orders" ON orders FOR DELETE USING (true);

CREATE POLICY "Allow public read categories" ON categories FOR SELECT USING (true);
CREATE POLICY "Allow public insert categories" ON categories FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public delete categories" ON categories FOR DELETE USING (true);

-- Storage bucket for product images
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Allow public upload product images" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'product-images');
CREATE POLICY "Allow public read product images" ON storage.objects
  FOR SELECT USING (bucket_id = 'product-images');
CREATE POLICY "Allow public delete product images" ON storage.objects
  FOR DELETE USING (bucket_id = 'product-images');

-- Seed default categories
INSERT INTO categories (name) VALUES
  ('School Uniform'),
  ('Stationery'),
  ('Books'),
  ('Sports'),
  ('Electronics'),
  ('Accessories')
ON CONFLICT (name) DO NOTHING;
