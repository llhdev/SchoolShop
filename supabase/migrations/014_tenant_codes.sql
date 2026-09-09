-- Timor Shop short tenant codes migration
-- Run after 013_account_management.sql (via `supabase db push` or SQL Editor).
-- 1) Gives every profile a short 8-character code (same XXXX-XXXX format as
--    order codes) so tenant accounts can be referenced without the long UUID.
-- 2) Updates handle_new_user so tenant detection is based on signup metadata
--    (shop_name) instead of the email domain — this lets the super admin give
--    a tenant a custom email while the account is still created as role='admin'.

-- 1. Short code column + generator (unambiguous alphabet, no 0/O/1/I).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tenant_code text UNIQUE;

CREATE OR REPLACE FUNCTION public.generate_short_code()
RETURNS text AS $$
  SELECT left(s, 4) || '-' || right(s, 4)
  FROM (
    SELECT string_agg(
      substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (floor(random() * 32) + 1)::int, 1),
      ''
    ) AS s
    FROM generate_series(1, 8)
  ) t;
$$ LANGUAGE sql;

-- 2. Auto-fill the code for every new profile. Existence check inside a retry
--    loop; the unique constraint is the final backstop.
CREATE OR REPLACE FUNCTION public.fill_tenant_code()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_code IS NULL THEN
    FOR i IN 1..10 LOOP
      NEW.tenant_code := public.generate_short_code();
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE tenant_code = NEW.tenant_code
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS fill_tenant_code ON public.profiles;
CREATE TRIGGER fill_tenant_code
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fill_tenant_code();

-- 3. Backfill codes for existing profiles (per-row retry on rare collisions).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.profiles WHERE tenant_code IS NULL LOOP
    LOOP
      BEGIN
        UPDATE public.profiles
        SET tenant_code = public.generate_short_code()
        WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- Regenerate and retry.
      END;
    END LOOP;
  END LOOP;
END $$;

-- 4. Tenant detection by signup metadata instead of email domain, so a custom
--    tenant email (e.g. abeshop@gmail.com) still produces role='admin'.
--    Username comes from metadata when provided (fallback: email prefix).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_username text;
  v_role text;
  v_shop_name text;
BEGIN
  IF new.raw_user_meta_data ->> 'shop_name' IS NOT NULL THEN
    v_role := 'admin';
    v_shop_name := new.raw_user_meta_data ->> 'shop_name';
    v_username := COALESCE(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      split_part(new.email, '@', 1)
    );
  ELSE
    v_role := 'user';
    v_shop_name := NULL;
    v_username := new.raw_user_meta_data ->> 'username';
  END IF;

  INSERT INTO public.profiles (id, role, email, username, shop_name)
  VALUES (new.id, v_role, new.email, v_username, v_shop_name)
  ON CONFLICT (id) DO UPDATE SET
    role = EXCLUDED.role,
    email = EXCLUDED.email,
    username = EXCLUDED.username,
    shop_name = EXCLUDED.shop_name;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
