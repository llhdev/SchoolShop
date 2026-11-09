import { supabase } from '../lib/supabase';
import { Branch } from '../types';

interface DbBranch {
  id: string;
  tenant_id: string;
  name: string;
  delivery_location: string | null;
  phone: string | null;
  position: number;
}

function toBranch(db: DbBranch): Branch & { tenantId: string; position: number } {
  return {
    id: db.id,
    tenantId: db.tenant_id,
    name: db.name,
    deliveryLocation: db.delivery_location ?? undefined,
    phone: db.phone ?? undefined,
    position: db.position,
  };
}

export type TenantBranch = Branch & { tenantId: string; position: number };

/** Branches of one or more shops, ordered for display. Publicly readable so
 *  anonymous checkout can offer the branch dropdown (migration 045). */
export async function fetchBranches(tenantIds: string[]): Promise<TenantBranch[]> {
  if (tenantIds.length === 0) return [];
  const { data, error } = await supabase
    .from('branches')
    .select('*')
    .in('tenant_id', tenantIds)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => toBranch(row as DbBranch));
}

/** Create a branch for a shop (super admin only, via RLS). Since migration
 *  046 branches exist only as the counterpart of a Branch Admin staff
 *  account — the staff label is the branch name. Returns the new branch id. */
export async function createBranch(tenantId: string, name: string): Promise<string> {
  const { data, error } = await supabase
    .from('branches')
    .insert({ tenant_id: tenantId, name })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Rename a branch (kept in sync with the owning staff account's label). */
export async function renameBranch(id: string, name: string): Promise<void> {
  const { error } = await supabase.from('branches').update({ name }).eq('id', id);
  if (error) throw error;
}

/** Delete a branch. profiles.branch_id references it ON DELETE SET NULL, so
 *  any linked staff account becomes unscoped automatically. */
export async function deleteBranch(id: string): Promise<void> {
  const { error } = await supabase.from('branches').delete().eq('id', id);
  if (error) throw error;
}
