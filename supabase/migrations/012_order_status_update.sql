-- 012_order_status_update.sql
-- Super-admin order status management (pending -> completed / failed).
--
-- The orders table ships with public SELECT/INSERT/DELETE policies and no
-- UPDATE policy at all, so today nobody can change an order's status through
-- the API. Add an UPDATE policy restricted to the super admin; tenant
-- admins cannot change order statuses.

DROP POLICY IF EXISTS "Allow super admin update orders" ON orders;

CREATE POLICY "Allow super admin update orders"
  ON orders FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());
