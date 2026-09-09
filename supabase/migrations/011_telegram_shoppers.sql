-- Telegram Mini App shoppers + order linkage.
-- Shoppers are identified by the initData Telegram signs for every Mini App
-- session (validated in the telegram-auth Edge Function, never trusted from
-- the client). Orders placed from the Mini App carry the shopper's
-- telegram_id so order history follows the Telegram account instead of the
-- device.

CREATE TABLE IF NOT EXISTS shoppers (
  telegram_id bigint PRIMARY KEY,
  first_name text NOT NULL,
  last_name text,
  username text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS telegram_id bigint;

CREATE INDEX IF NOT EXISTS orders_telegram_id_idx
  ON orders (telegram_id);

-- Public read/write for the MVP, consistent with the existing products and
-- orders policies. All shopper writes in practice go through the
-- telegram-auth Edge Function using the service role.
ALTER TABLE shoppers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'shoppers' AND policyname = 'shoppers_public'
  ) THEN
    CREATE POLICY shoppers_public ON shoppers
      FOR ALL TO anon, authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
