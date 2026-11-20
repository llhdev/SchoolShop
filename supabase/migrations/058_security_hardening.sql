-- 058: Security hardening (post-audit batch).
--
-- 1) handle_new_user no longer derives role='admin' from signup metadata —
--    raw_user_meta_data is fully client-controlled, so anyone with the anon
--    key could self-signup as a tenant admin. Profiles are now always created
--    as role='user'; tenant promotion goes through the super-admin-only RPC
--    admin_promote_to_tenant (used by Tenant Management after signUp).
-- 2) Revoke EXECUTE on verify_function_secret / request_payment_verification
--    from anon/authenticated/PUBLIC. Both run fine internally: every caller
--    (trigger_verify_order_payment, retry_payment_verification) is SECURITY
--    DEFINER owned by postgres, which bypasses EXECUTE checks.
-- 3) Drop anonymous DELETE policies on storage buckets (payment-proofs,
--    bank-qrs, shop-logos) — deletes go through r2-upload-sign's
--    capability-gated action.
-- 4) Drop "Admins read payment proofs" on storage.objects: it granted ANY
--    authenticated user (signup is open) read access to the legacy private
--    proofs bucket. Nothing uses it — proof viewing goes through
--    r2-upload-sign's sign-proof-get (service role signed URL).
-- 5) Revoke the stray anon grant on delete_tenant_user (internally guarded,
--    but the grant was never justified).
-- 6) Pin search_path on the remaining unpinned SECURITY DEFINER functions.

-- 1. Signup never grants roles ------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, role, email, username, shop_name)
  VALUES (
    new.id,
    'user',
    new.email,
    nullif(new.raw_user_meta_data ->> 'username', ''),
    NULL
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    username = EXCLUDED.username;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Super-admin-only promotion of a freshly signed-up user to tenant admin.
-- The profiles guard trigger (052) early-returns for the super admin, so this
-- UPDATE is allowed; capabilities start all-on (one-man shop, per 048).
CREATE OR REPLACE FUNCTION public.admin_promote_to_tenant(
  p_user_id uuid,
  p_username text,
  p_shop_name text
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only the super admin can promote tenants.';
  END IF;

  UPDATE public.profiles
  SET role = 'admin',
      username = lower(trim(p_username)),
      shop_name = trim(p_shop_name),
      parent_tenant_id = NULL,
      staff_financial = true,
      staff_shop = true,
      staff_branch = true
  WHERE id = p_user_id
    AND role = 'user'
    AND parent_tenant_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found, or already promoted.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.admin_promote_to_tenant(uuid, text, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_promote_to_tenant(uuid, text, text) TO authenticated;

-- 2. Internal verification helpers are not public API -------------------------
REVOKE EXECUTE ON FUNCTION public.verify_function_secret() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_payment_verification(text) FROM anon, authenticated, PUBLIC;

-- 3. No anonymous storage deletes ----------------------------------------------
DROP POLICY IF EXISTS "Allow public delete payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Allow public delete bank qrs" ON storage.objects;
DROP POLICY IF EXISTS "Allow public delete shop logos" ON storage.objects;

-- 4. Legacy private proofs bucket: no direct storage reads ---------------------
DROP POLICY IF EXISTS "Admins read payment proofs" ON storage.objects;

-- 5. delete_tenant_user stays super-admin-only ---------------------------------
REVOKE EXECUTE ON FUNCTION public.delete_tenant_user(uuid) FROM anon;

-- 6. Pin search_path on previously unpinned definer functions ------------------
ALTER FUNCTION public.is_admin() SET search_path = public;
ALTER FUNCTION public.is_super_admin() SET search_path = public;
ALTER FUNCTION public.get_admin_by_username(text) SET search_path = public;
ALTER FUNCTION public.get_accounts_by_username(text) SET search_path = public;
ALTER FUNCTION public.delete_tenant_user(uuid) SET search_path = public;
ALTER FUNCTION public.fetch_products_with_shop() SET search_path = public;
