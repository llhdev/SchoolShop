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
  const { data, error } = await supabase.functions.invoke('create-tenant', {
    body: { username, password },
  });

  if (error) {
    throw new Error(error.message || 'Failed to create tenant');
  }

  if (!data || data.error) {
    throw new Error(data?.error || 'Failed to create tenant');
  }

  return {
    id: data.id,
    username: data.username,
    email: data.email,
    role: 'admin',
    createdAt: new Date().toISOString(),
  };
}
