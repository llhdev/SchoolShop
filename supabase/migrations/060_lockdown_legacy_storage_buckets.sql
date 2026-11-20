-- Timor Shop: lock down the legacy Supabase storage buckets.
-- Run after 059_security_quick_wins.sql.
--
-- All uploads moved to Cloudflare R2 (presigned via r2-upload-sign) long ago;
-- payment proofs live in the PRIVATE R2 proofs bucket. But the legacy public
-- Supabase buckets kept their 020/023-era anonymous policies:
--
--   payment-proofs : public read + public upload  <- bank-transfer receipts,
--   bank-qrs       : public upload                 world-readable by URL
--   shop-logos     : public upload
--
-- This migration:
--   1. Drops anonymous INSERT on all three buckets (nothing current uploads
--      to them; the R2 path is the only writer).
--   2. Drops public SELECT on payment-proofs — financial screenshots must not
--      be world-readable. Reads on bank-qrs / shop-logos STAY public: legacy
--      profiles.shop_logo_url and bank qr_image_url values may still point at
--      those buckets and are rendered as plain <img> URLs.
--
-- SEQUENCING NOTE: order rows written before the R2 move may hold full public
-- payment-proofs URLs in payment_proofs. Those images stop rendering in the
-- admin UI once the read policy drops. Check first, and migrate if needed:
--
--   SELECT id, payment_proofs FROM orders
--   WHERE payment_proofs::text LIKE '%/object/public/payment-proofs/%';
--
-- (migrate-proofs-to-r2.js covers the payment-proofs-private bucket; legacy
-- public-URL rows need their objects copied and the column rewritten to bare
-- keys — do that before applying this migration if the query returns rows.)

-- 1. No anonymous uploads ---------------------------------------------------
DROP POLICY IF EXISTS "Allow public upload payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Allow public upload bank qrs" ON storage.objects;
DROP POLICY IF EXISTS "Allow public upload shop logos" ON storage.objects;

-- 2. Payment proofs are not public data -------------------------------------
DROP POLICY IF EXISTS "Allow public read payment proofs" ON storage.objects;
