-- Timor Shop tenant self-service signup migration
-- Replaces the Edge Function path with an in-app signUp + Postgres trigger flow.
--
-- How it works:
-- 1. The super admin opens Tenant Management and enters a username + password.
-- 2. The app derives a tenant email as `<username>@tenant.schoolshop.app` and calls
--    `supabase.auth.signUp({ email, password })` with a secondary, in-memory client.
-- 3. The project's Auth config has `mailer_autoconfirm` enabled, so tenant emails are
--    confirmed automatically on signup.
-- 4. The AFTER INSERT trigger `on_auth_user_created` creates the public profile with
--    `role = 'admin'` and the chosen username for tenant emails. All other signups
--    become `role = 'user'`.

-- Create the public profile for every new auth user.
-- Tenant emails become role='admin' with the username from the local part.
-- All other signups become role='user'.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_username text;
  v_role text;
BEGIN
  IF new.email LIKE '%@tenant.schoolshop.app' THEN
    v_username := split_part(new.email, '@', 1);
    v_role := 'admin';
  ELSE
    v_username := new.raw_user_meta_data ->> 'username';
    v_role := 'user';
  END IF;

  INSERT INTO public.profiles (id, role, email, username)
  VALUES (new.id, v_role, new.email, v_username)
  ON CONFLICT (id) DO UPDATE SET
    role = EXCLUDED.role,
    email = EXCLUDED.email,
    username = EXCLUDED.username;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
