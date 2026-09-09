import { createClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface Tenant {
  id: string;
  code: string | null;
  username: string | null;
  email: string | null;
  shopName: string | null;
  role: 'admin';
  createdAt: string;
}

interface DbProfile {
  id: string;
  tenant_code: string | null;
  username: string | null;
  email: string | null;
  shop_name: string | null;
  role: 'admin';
  created_at: string;
}

function toTenant(db: DbProfile): Tenant {
  return {
    id: db.id,
    code: db.tenant_code,
    username: db.username,
    email: db.email,
    shopName: db.shop_name,
    role: db.role,
    createdAt: db.created_at,
  };
}

const TENANT_EMAIL_DOMAIN = 'tenant.schoolshop.app';

function getTenantEmail(username: string): string {
  return `${username.toLowerCase()}@${TENANT_EMAIL_DOMAIN}`;
}

// A secondary, in-memory client is used for tenant signUp so the super admin's
// active session is not replaced by the newly created tenant session.
function createSignupClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase environment variables. ' +
        'Make sure EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY are set.'
    );
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function fetchTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, tenant_code, username, email, shop_name, role, created_at')
    .eq('role', 'admin')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toTenant);
}

export async function fetchTenantById(id: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, tenant_code, username, email, shop_name, role, created_at')
    .eq('id', id)
    .eq('role', 'admin')
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data ? toTenant(data) : null;
}

export async function deleteTenant(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_tenant_user', {
    tenant_id: id,
  });
  if (error) throw error;
}

/** Super admin edits a tenant's username (gateway), email, and shop name. */
export async function adminUpdateTenant(
  id: string,
  username: string,
  email: string,
  shopName: string
): Promise<void> {
  const cleanUsername = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();
  const cleanShopName = shopName.trim();

  if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
    throw new Error('Username must be 3–20 characters: letters, numbers, underscores.');
  }
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email.');
  }
  if (!cleanShopName) {
    throw new Error('Shop name is required.');
  }

  const { error } = await supabase.rpc('admin_update_tenant', {
    tenant_id: id,
    new_username: cleanUsername,
    new_email: cleanEmail,
    new_shop_name: cleanShopName,
  });
  if (error) {
    if (error.code === '23505') {
      throw new Error(`Username "${cleanUsername}" is already taken.`);
    }
    throw new Error(error.message || 'Failed to update tenant.');
  }
}

/** Super admin sets a tenant's password (empty string = leave unchanged). */
export async function adminSetTenantPassword(
  id: string,
  newPassword: string
): Promise<void> {
  if (newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const { error } = await supabase.rpc('admin_set_tenant_password', {
    tenant_id: id,
    new_password: newPassword,
  });
  if (error) throw new Error(error.message || 'Failed to set password.');
}

export async function createTenant(
  username: string,
  password: string,
  shopName: string,
  email?: string
): Promise<Tenant> {
  const cleanUsername = username.trim().toLowerCase();
  const cleanShopName = shopName.trim();
  // The super admin may give a custom email; otherwise derive one from the
  // username so the account works with Supabase Auth regardless.
  const customEmail = email?.trim().toLowerCase();
  const finalEmail = customEmail || getTenantEmail(cleanUsername);

  if (!cleanUsername) {
    throw new Error('Username is required.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  if (!cleanShopName) {
    throw new Error('Shop name is required.');
  }
  if (customEmail && !customEmail.includes('@')) {
    throw new Error('Please enter a valid email.');
  }

  const signupClient = createSignupClient();

  const { data, error } = await signupClient.auth.signUp({
    email: finalEmail,
    password,
    options: {
      data: { username: cleanUsername, shop_name: cleanShopName },
    },
  });

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes('already registered') || message.includes('already exists')) {
      throw new Error(`Username or email is already taken.`);
    }
    throw new Error(error.message || 'Failed to create tenant');
  }

  if (!data.user) {
    throw new Error('Failed to create tenant. No user was returned.');
  }

  return {
    id: data.user.id,
    code: null, // Assigned by the database trigger; refetch to display it.
    username: cleanUsername,
    email: finalEmail,
    shopName: cleanShopName,
    role: 'admin',
    createdAt: new Date().toISOString(),
  };
}
