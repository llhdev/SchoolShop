-- Timor Shop: owners can UPDATE their shop's profile rows (049).
-- Run after 048_owner_manages_staff.sql.
--
-- 048 let the shop owner manage its staff, but the only profiles UPDATE
-- policy since 003 is super-admin-only — so the owner's staff promotion
-- (the profiles.update in createStaffAccount) and staff edits failed with an
-- RLS violation. This adds the missing owner-scoped policy.
--
-- USING covers three row shapes:
--   * id = auth.uid()            — the owner's own row (self-toggle path),
--   * parent_tenant_id = auth.uid() — the owner's existing staff,
--   * role = 'user'              — a fresh signup being promoted to staff.
-- The promotion shape itself is enforced by the 048 guard trigger
-- (protect_profile_privileged_columns): role/email/staff columns on a 'user'
-- row can only change into the promotion pattern. Unprotected columns on a
-- 'user' row (a nobody's profile) carry no privilege, so exposing them to
-- owners is harmless.
-- WITH CHECK excludes 'user': you cannot turn a row INTO a plain user or
-- re-parent it away — staff rows must stay (or become) the owner's staff.

CREATE POLICY "Allow owner manage shop profiles" ON public.profiles
  FOR UPDATE USING (
    public.is_shop_owner()
    AND (
      id = auth.uid()
      OR parent_tenant_id = auth.uid()
      OR role = 'user'
    )
  ) WITH CHECK (
    public.is_shop_owner()
    AND (
      id = auth.uid()
      OR parent_tenant_id = auth.uid()
    )
  );
