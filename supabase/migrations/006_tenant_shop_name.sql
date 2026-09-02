-- Timor Shop tenant shop name migration
-- Adds a human-readable shop name to each tenant admin profile.

-- 1. Store the shop name on the profile.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS shop_name text;

-- 2. Update the auth trigger to read the shop name from user metadata and store it.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_username text;
  v_role text;
  v_shop_name text;
BEGIN
  IF new.email LIKE '%@tenant.schoolshop.app' THEN
    v_username := split_part(new.email, '@', 1);
    v_role := 'admin';
    v_shop_name := new.raw_user_meta_data ->> 'shop_name';
  ELSE
    v_username := new.raw_user_meta_data ->> 'username';
    v_role := 'user';
    v_shop_name := NULL;
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Backfill existing tenant admins without a shop name.
UPDATE public.profiles
SET shop_name = COALESCE(shop_name, username, 'Untitled Shop')
WHERE role = 'admin' AND shop_name IS NULL;
