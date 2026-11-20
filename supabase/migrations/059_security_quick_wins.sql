-- Timor Shop: security quick wins (audit follow-up to 058).
--
-- 1. shoppers becomes read-only for clients -------------------------------
--    011 granted FOR ALL (select/insert/update/delete) to anon +
--    authenticated "for the MVP". Every legitimate shopper write goes
--    through the telegram-auth Edge Function (service role, initData HMAC
--    validated), so anonymous clients never need write access. The open
--    policy let anyone rewrite or wipe the shopper directory; order history
--    joins on this table, so the damage cascaded. Reads stay public: the
--    admin Analysis screen shows shopper names.
DROP POLICY IF EXISTS shoppers_public ON public.shoppers;

CREATE POLICY shoppers_read ON public.shoppers
  FOR SELECT TO anon, authenticated
  USING (true);

-- 2. Retire the legacy update_own_bank_details RPC -------------------------
--    032 kept it granted to all authenticated users so pre-031 cached app
--    bundles could save bank details into the new column. Those bundles are
--    long gone (052's update_own_bank_accounts, owner-only, is the live
--    path), and the legacy RPC has no owner check — any staff account could
--    write the retired columns on its own row. No current client calls it.
REVOKE EXECUTE ON FUNCTION public.update_own_bank_details(text, text)
  FROM anon, authenticated, PUBLIC;

-- 3. Pin search_path on the last unpinned SECURITY DEFINER function --------
--    058 pinned every definer function except this trigger function.
ALTER FUNCTION public.increment_product_order_counts() SET search_path = public;

NOTIFY pgrst, 'reload schema';
