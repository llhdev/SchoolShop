import { supabase } from '../lib/supabase';

export interface OwnProfile {
  username: string | null;
  email: string | null;
  shopName: string | null;
}

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

/** The signed-in admin's own profile row (username / email / shop name). */
export async function fetchOwnProfile(): Promise<OwnProfile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('username, email, shop_name')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    username: data.username,
    email: data.email,
    shopName: data.shop_name,
  };
}

/** Change the signed-in admin's own login username (gateway). */
export async function changeGateway(newUsername: string): Promise<void> {
  const clean = newUsername.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(clean)) {
    throw new Error('Gateway must be 3–20 characters: letters, numbers, underscores.');
  }

  const { data: taken } = await supabase.rpc('get_admin_by_username', {
    username: clean,
  });
  if (taken && taken.length > 0) {
    throw new Error(`Gateway "${clean}" is already taken.`);
  }

  const { error } = await supabase.rpc('change_own_username', {
    new_username: clean,
  });
  if (error) {
    if (error.code === '23505') {
      throw new Error(`Gateway "${clean}" is already taken.`);
    }
    throw new Error(error.message || 'Failed to change gateway.');
  }
}

/** Change the signed-in admin's password after verifying the current one. */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  if (newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email;
  if (!email) throw new Error('Could not determine your account email.');

  // Verify the current password before allowing the change. This signs in
  // the same user again, so the active session simply refreshes.
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (signInError) {
    throw new Error('Current password is incorrect.');
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message || 'Failed to change password.');
}
