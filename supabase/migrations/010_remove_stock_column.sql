-- Remove the stock column from products; inventory is no longer tracked.
ALTER TABLE products DROP COLUMN IF EXISTS stock;

NOTIFY pgrst, 'reload schema';
