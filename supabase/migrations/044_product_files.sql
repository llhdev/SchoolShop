-- 044: Downloadable PDF files attached to products (digital books).
--
-- One product post can carry many PDFs (e.g. "Grade 1 Books"). Files live in
-- the PUBLIC R2 bucket under books/ — protection for paid books comes from
-- hiding the keys, not from the bucket:
--   - Anonymous shoppers can SELECT only files whose product is free
--     (price = 0). Paid posts' keys are never exposed to anon clients.
--   - Paid files are revealed by the r2-upload-sign edge function's
--     sign-book-get action after it verifies the buyer's order item reached
--     'paid' (service role bypasses RLS for that lookup).
--   - Tenant admins manage files on their own products; the super admin
--     manages all. Policies mirror the products policies (003).

CREATE TABLE IF NOT EXISTS public.product_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  -- Display name shown on download buttons, e.g. "Mathematics Grade 1".
  name text NOT NULL,
  -- R2 object key: books/<timestamp>-<rand>.pdf (public bucket, img.timor.et).
  key text NOT NULL UNIQUE,
  size_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_files_product_id_idx ON public.product_files (product_id);

ALTER TABLE public.product_files ENABLE ROW LEVEL SECURITY;

-- Anyone can list files of free posts (price = 0). Paid posts' files are
-- invisible to anonymous shoppers — they surface via sign-book-get only
-- after payment is confirmed.
CREATE POLICY "Public read files of free products" ON public.product_files
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_files.product_id AND p.price = 0
    )
  );

CREATE POLICY "Admins read own product files" ON public.product_files
  FOR SELECT USING (
    public.is_super_admin() OR (
      public.is_admin() AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id AND p.owner_id = auth.uid()
      )
    )
  );

CREATE POLICY "Admins insert own product files" ON public.product_files
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR (
      public.is_admin() AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id AND p.owner_id = auth.uid()
      )
    )
  );

CREATE POLICY "Admins update own product files" ON public.product_files
  FOR UPDATE USING (
    public.is_super_admin() OR (
      public.is_admin() AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id AND p.owner_id = auth.uid()
      )
    )
  );

CREATE POLICY "Admins delete own product files" ON public.product_files
  FOR DELETE USING (
    public.is_super_admin() OR (
      public.is_admin() AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_files.product_id AND p.owner_id = auth.uid()
      )
    )
  );
