-- Add an optional compare-at price for discount display.
-- When set and higher than price, the UI shows a strikethrough original
-- price and a discount badge.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS compare_at_price numeric;

NOTIFY pgrst, 'reload schema';
