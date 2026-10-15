-- Timor Shop: student name on orders + optional delivery location
-- Checkout now collects the shopper's student name (required, first field)
-- and the delivery location becomes optional. student_name is nullable so
-- legacy rows stay valid; new orders always set it.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS student_name text;

ALTER TABLE public.orders
  ALTER COLUMN location DROP NOT NULL;
