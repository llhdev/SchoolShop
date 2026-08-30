import { supabase } from '../lib/supabase';

export interface Tenant {
  id: string;
  email: string | null;
  role: 'admin';
  createdAt: string;
}

interface DbProfile {
  id: string;
  email: string | null;
  role: 'admin';
  created_at: string;
}

function toTenant(db: DbProfile): Tenant {
  return {
    id: db.id,
    email: db.email,
    role: db.role,
    createdAt: db.created_at,
  };
}

export async function fetchTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, role, created_at')
    .eq('role', 'admin')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toTenant);
}

export async function deleteTenant(id: string): Promise<void> {
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) throw error;
}
