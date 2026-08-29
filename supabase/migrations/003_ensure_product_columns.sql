-- Ensure products table has all columns expected by the app.
-- This migration is idempotent in case the initial schema was partially applied.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

NOTIFY pgrst, 'reload schema';
