import { createClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface Tenant {
  id: string;
  username: string | null;
  email: string | null;
  role: 'admin';
  createdAt: string;
}

interface DbProfile {
  id: string;
  username: string | null;
  email: string | null;
  role: 'admin';
  created_at: string;
}

function toTenant(db: DbProfile): Tenant {
  return {
    id: db.id,
    username: db.username,
    email: db.email,
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
    .select('id, username, email, role, created_at')
    .eq('role', 'admin')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toTenant);
}

export async function deleteTenant(id: string): Promise<void> {
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) throw error;
}

export async function createTenant(
  username: string,
  password: string
): Promise<Tenant> {
  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername) {
    throw new Error('Username is required.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const email = getTenantEmail(cleanUsername);
  const signupClient = createSignupClient();

  const { data, error } = await signupClient.auth.signUp({
    email,
    password,
  });

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes('already registered') || message.includes('already exists')) {
      throw new Error(`Username "${cleanUsername}" is already taken.`);
    }
    throw new Error(error.message || 'Failed to create tenant');
  }

  if (!data.user) {
    throw new Error('Failed to create tenant. No user was returned.');
  }

  return {
    id: data.user.id,
    username: cleanUsername,
    email,
    role: 'admin',
    createdAt: new Date().toISOString(),
  };
}
