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

/** Replace a shop's branch list (super admin only, via RLS). Rows without an
 *  id are inserted; rows whose id is missing from the list are deleted. */
export async function setTenantBranches(
  tenantId: string,
  branches: { id?: string; name: string; deliveryLocation?: string; phone?: string }[]
): Promise<void> {
  const keepIds = branches.map((b) => b.id).filter((id): id is string => !!id);
  const { error: deleteError } = await supabase
    .from('branches')
    .delete()
    .eq('tenant_id', tenantId)
    .not('id', 'in', keepIds.length > 0 ? `(${keepIds.join(',')})` : '(00000000-0000-0000-0000-000000000000)');
  if (deleteError) throw deleteError;

  if (branches.length === 0) return;
  const { error: upsertError } = await supabase.from('branches').upsert(
    branches.map((b, index) => ({
      ...(b.id ? { id: b.id } : {}),
      tenant_id: tenantId,
      name: b.name,
      delivery_location: b.deliveryLocation ?? null,
      phone: b.phone ?? null,
      position: index,
    }))
  );
  if (upsertError) throw upsertError;
}
