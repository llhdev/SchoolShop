-- Timor Shop bank-transfer payments migration
-- Run after 019_fix_stamp_order_tenants.sql.
-- Adds: per-tenant bank details on profiles, payment proof photos on orders,
-- a 4-state order status flow manageable by any admin, and storage buckets
-- for payment proofs and tenant bank QR codes.

-- 1. Bank transfer details on tenant profiles.
--    The super admin sets these when creating/editing a tenant; a tenant can
--    also maintain their own via update_own_bank_details (below).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bank_account_number text,
  ADD COLUMN IF NOT EXISTS bank_qr_image_url text;

-- 2. Payment proof photos on orders: jsonb object mapping the tenant's
--    profile id (the same owner_id stamped onto order items) to a public
--    payment-proofs storage URL uploaded by the shopper at checkout.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_proofs jsonb NOT NULL DEFAULT '{}';

-- 3. Four-state status flow: pending -> paid -> on_the_way -> completed.
--    Backfill the retired delivered/failed values, then constrain.
UPDATE public.orders SET status = 'completed' WHERE status IN ('delivered', 'failed');

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check CHECK (status IN ('pending', 'paid', 'on_the_way', 'completed'));

-- 4. Any admin can now update the status of orders that involve their shop:
--    the super admin keeps global access; a tenant admin is allowed when their
--    auth uid is in the order's tenant_ids (set by the stamp_order_tenants
--    trigger). Replaces migration 012's super-admin-only UPDATE policy.
DROP POLICY IF EXISTS "Allow super admin update orders" ON public.orders;

CREATE POLICY "Allow admins update orders"
  ON public.orders FOR UPDATE TO authenticated
  USING (public.is_super_admin() OR tenant_ids @> ARRAY[auth.uid()]::uuid[])
  WITH CHECK (public.is_super_admin() OR tenant_ids @> ARRAY[auth.uid()]::uuid[]);

-- 5. Storage buckets: payment proofs (shopper uploads at checkout) and tenant
--    bank QR codes. Both are public-read so the Telegram bot (and the shopper's
--    receipt view) can fetch them by URL; insert/delete follow the MVP's public
--    pattern used for product-images in 001.
INSERT INTO storage.buckets (id, name, public) VALUES
  ('payment-proofs', 'payment-proofs', true),
  ('bank-qrs', 'bank-qrs', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Allow public upload payment proofs" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'payment-proofs');
CREATE POLICY "Allow public read payment proofs" ON storage.objects
  FOR SELECT USING (bucket_id = 'payment-proofs');
CREATE POLICY "Allow public delete payment proofs" ON storage.objects
  FOR DELETE USING (bucket_id = 'payment-proofs');

CREATE POLICY "Allow public upload bank qrs" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'bank-qrs');
CREATE POLICY "Allow public read bank qrs" ON storage.objects
  FOR SELECT USING (bucket_id = 'bank-qrs');
CREATE POLICY "Allow public delete bank qrs" ON storage.objects
  FOR DELETE USING (bucket_id = 'bank-qrs');

-- 6. Self-service: a tenant admin maintains their own bank transfer details.
--    SECURITY DEFINER because profiles UPDATE policies only cover the super
--    admin; only the caller's own row is touched. The super admin edits tenant
--    bank details with direct profiles updates (existing super-admin policy).
CREATE OR REPLACE FUNCTION public.update_own_bank_details(
  p_account_number text,
  p_qr_image_url text
)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET bank_account_number = nullif(trim(p_account_number), ''),
      bank_qr_image_url = nullif(trim(p_qr_image_url), '')
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the current user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.update_own_bank_details(text, text) TO authenticated;
