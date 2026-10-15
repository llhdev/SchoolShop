-- Timor Shop product detail images
-- Optional extra images (size charts, labels, close-ups) that tenants upload
-- in addition to the main product gallery; listed under the description on
-- the product detail page.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS detail_images text[] NOT NULL DEFAULT '{}';
