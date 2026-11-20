-- Timor Shop: drop the 002-era orders read policy (065).
-- Run after 064_capability_scoped_reads.sql.
--
-- 002 created "Allow admin read orders" (SELECT TO public USING
-- is_admin()) back when is_admin() was the only gate. It survived every
-- later rework because 016's world-readable policy made it moot. With 062's
-- public read gone it became live again — and it undermines 064 twice over:
--   * is_admin() is true for EVERY admin/staff account, so non-financial
--     staff bypass the Financial capability gate and can SELECT full order
--     rows (money, proofs, references) directly;
--   * it has no tenant_ids scoping at all, so any staff account can read
--     EVERY shop's orders.
-- The 064 policy ("Admins read scoped orders": super admin, or the shop's
-- financial staff) is the intended sole direct-read path; everyone else
-- uses get_scoped_orders.
DROP POLICY IF EXISTS "Allow admin read orders" ON public.orders;

NOTIFY pgrst, 'reload schema';
