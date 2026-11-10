-- Timor Shop: enable Realtime replication for the tables the app subscribes
-- to. Run after 054_order_insert_hardening.sql.
--
-- Clients keep themselves in sync through postgres_changes subscriptions:
-- the products/orders/categories lists, the per-shop is_active kick on
-- profiles, and the payment-verification badge. Those events only fire for
-- tables in the supabase_realtime publication — on a fresh project nothing is
-- in it, so every subscription silently never fired and changes only appeared
-- after a reload (e.g. the order-detail header badge staying "Paid" after an
-- item moved on). Production had the tables added by hand; this makes it part
-- of the migration chain so staging and fresh backends get it too. The
-- existence checks keep re-runs (and prod, where some already exist) safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'products'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'categories'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.categories;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'payment_verifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_verifications;
  END IF;
END $$;
