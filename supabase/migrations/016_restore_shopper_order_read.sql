-- Timor Shop restore shopper order read migration
-- Run this in the Supabase SQL Editor after 015_order_telegram_backfill.sql.
-- Migration 002 locked orders SELECT to admins only. That silently broke the
-- Mini App shopper order history: inserts still succeeded (201), but an
-- anonymous client's fetch-by-telegram_id returned zero rows (RLS filters
-- rather than errors), and the client replaced its local history with that
-- empty result on every launch. It also blocked Supabase Realtime delivery,
-- which requires a SELECT policy on the table.
-- Restore the MVP-intended public read so shopper order history (and its
-- realtime updates) work. Note: order rows include the customer's phone and
-- delivery location — anyone with the anon key can read them, same posture
-- as the publicly insertable orders and shoppers tables. Harden later with
-- per-shopper JWT claims if the app moves beyond the MVP.
CREATE POLICY "Allow public read orders"
  ON orders FOR SELECT TO anon, authenticated
  USING (true);
