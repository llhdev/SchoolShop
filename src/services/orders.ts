import { supabase } from '../lib/supabase';
import { debounce } from '../lib/debounce';
import { CartItem, Order, OrderStatus } from '../types';
import { generateOrderCode } from '../utils/orderCode';
import { getCartItemLineId } from '../utils/variants';
import { CACHE_KEYS, getCached, setCached } from './cache';

const REFETCH_DEBOUNCE_MS = 500;

interface DbOrder {
  id: string;
  items: unknown;
  total: number;
  payment_method: string;
  status: string;
  location: string | null;
  phone_number: string;
  student_name: string | null;
  created_at: string;
  telegram_id: number | null;
  tenant_ids: string[] | null;
  payment_proofs: Record<string, string> | null;
  payment_references: Record<string, { provider: 'cbe' | 'telebirr'; reference: string; key: string }> | null;
  shipping_fees: Record<string, number> | null;
  item_statuses: Record<string, string> | null;
}

function toOrder(db: DbOrder): Order {
  return {
    id: db.id,
    items: db.items as Order['items'],
    total: db.total,
    paymentMethod: db.payment_method as Order['paymentMethod'],
    status: db.status as Order['status'],
    location: db.location ?? '',
    phoneNumber: db.phone_number,
    studentName: db.student_name ?? undefined,
    createdAt: db.created_at,
    telegramId: db.telegram_id ?? undefined,
    tenantIds: db.tenant_ids ?? undefined,
    paymentProofs: db.payment_proofs ?? undefined,
    paymentReferences: db.payment_references ?? undefined,
    shippingFees: db.shipping_fees ?? undefined,
    itemStatuses: db.item_statuses ?? undefined,
  };
}

function toDbOrder(order: Order): DbOrder {
  return {
    id: order.id,
    items: order.items,
    total: order.total,
    payment_method: order.paymentMethod,
    status: order.status,
    location: order.location || null,
    phone_number: order.phoneNumber,
    student_name: order.studentName ?? null,
    created_at: order.createdAt,
    telegram_id: order.telegramId ?? null,
    tenant_ids: order.tenantIds ?? null,
    payment_proofs: order.paymentProofs ?? {},
    payment_references: order.paymentReferences ?? {},
    shipping_fees: order.shippingFees ?? {},
    item_statuses: order.itemStatuses ?? {},
  };
}

export async function loadOrdersFromCache(): Promise<Order[]> {
  return (await getCached<Order[]>(CACHE_KEYS.orders)) ?? [];
}

export async function saveOrdersToCache(orders: Order[]): Promise<void> {
  await setCached(CACHE_KEYS.orders, orders);
}

/** PostgREST silently truncates responses at 1000 rows, so a plain select
 *  under-reports once the table grows past that. Page through with range()
 *  until a short page comes back. */
const PAGE_SIZE = 1000;

async function fetchAllOrderPages(
  buildQuery: () => ReturnType<ReturnType<typeof supabase.from>['select']>
): Promise<Order[]> {
  const all: Order[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []).map((row) => toOrder(row as unknown as DbOrder));
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
    from += PAGE_SIZE;
  }
}

/** Tenant admins only see orders containing their own products.
 *  tenant_ids is filled server-side by the stamp_order_tenants trigger. */
export async function fetchOrders(tenantId?: string): Promise<Order[]> {
  return fetchAllOrderPages(() => {
    let query = supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });
    if (tenantId) query = query.contains('tenant_ids', [tenantId]);
    return query;
  });
}

/** Line items of an order that belong to one tenant. Item snapshots are
 *  stamped with product.owner_id by the DB trigger; fall back to the
 *  client-side camelCase ownerId for rows written before the trigger. */
export function getOrderItemsForTenant(order: Order, tenantId: string): Order['items'] {
  return order.items.filter((item) => {
    const product = item.product as { owner_id?: string; ownerId?: string };
    return product.owner_id === tenantId || product.ownerId === tenantId;
  });
}

/** Orders placed by one Telegram shopper, newest first. */
export async function fetchOrdersByTelegramId(telegramId: number): Promise<Order[]> {
  return fetchAllOrderPages(() =>
    supabase
      .from('orders')
      .select('*')
      .eq('telegram_id', telegramId)
      .order('created_at', { ascending: false })
  );
}

export async function createOrder(order: Order): Promise<Order> {
  // The order id IS the customer-facing order code. Generate a short random
  // code here (ignoring any client-side placeholder id) and retry on the
  // unlikely chance of a primary-key collision.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const orderWithCode: Order = { ...order, id: generateOrderCode() };
    const { error } = await supabase.from('orders').insert(toDbOrder(orderWithCode));
    if (!error) return orderWithCode;
    const isCollision = error.code === '23505';
    if (!isCollision || attempt === MAX_ATTEMPTS) throw error;
  }
  throw new Error('Failed to place order. Please try again.');
}

/** Backfill: stamp a shopper's telegram_id onto an order placed before
 *  initData validation finished (telegram_id is still NULL). No-op if the
 *  order already belongs to someone. */
export async function attachOrderTelegramId(orderId: string, telegramId: number): Promise<void> {
  const { error } = await supabase.rpc('attach_order_telegram_id', {
    p_order_id: orderId,
    p_telegram_id: telegramId,
  });
  if (error) throw error;
}

/** Status transition (pending -> paid -> on_the_way -> completed). Allowed by
 *  RLS for the super admin and for tenant admins in the order's tenant_ids.
 *  Per-item status changes go through updateOrderItemStatus instead. */
export async function updateOrderStatus(id: string, status: Order['status']): Promise<void> {
  const { error } = await supabase.from('orders').update({ status }).eq('id', id);
  if (error) throw error;
}

/** Stable per-item key inside an order: "productId:selectedImageIndex", plus
 *  ":Group=Option|…" when the line has variant selections (migration 035).
 *  Unique per order because the cart merges identical product+image+variant
 *  lines. Items without options keep the legacy format, so status keys on
 *  orders written before variants still match. */
export function getItemKey(item: CartItem): string {
  return getCartItemLineId(item);
}

/** Effective status of one line item: its own entry in itemStatuses, falling
 *  back to the order-level status (items never explicitly set, legacy rows). */
export function getItemStatus(order: Order, item: CartItem): OrderStatus {
  return (order.itemStatuses?.[getItemKey(item)] ?? order.status) as OrderStatus;
}

/** Set the status of a single line item. Enforced server-side: super admin or
 *  the tenant that owns the item (migration 022 RPC). */
export async function updateOrderItemStatus(
  orderId: string,
  itemKey: string,
  status: OrderStatus
): Promise<void> {
  const { error } = await supabase.rpc('update_order_item_status', {
    p_order_id: orderId,
    p_item_key: itemKey,
    p_status: status,
  });
  if (error) throw error;
}

export function subscribeToOrders(onChange: (orders: Order[]) => void, tenantId?: string) {
  // Debounce so a burst of events triggers one refetch.
  const refetch = debounce(async () => {
    try {
      const orders = await fetchOrders(tenantId);
      onChange(orders);
    } catch {
      // Keep cached data if the refresh fails.
    }
  }, REFETCH_DEBOUNCE_MS);

  const subscription = supabase
    .channel('orders_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'orders' },
      () => refetch()
    )
    .subscribe();
  return () => {
    supabase.removeChannel(subscription);
  };
}

/** Realtime for one shopper's orders (Telegram Mini App sessions). */
export function subscribeToShopperOrders(
  telegramId: number,
  onChange: (orders: Order[]) => void
) {
  const refetch = debounce(async () => {
    try {
      const orders = await fetchOrdersByTelegramId(telegramId);
      onChange(orders);
    } catch {
      // Keep cached data if the refresh fails.
    }
  }, REFETCH_DEBOUNCE_MS);

  const subscription = supabase
    .channel(`orders_shopper_${telegramId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'orders' },
      () => refetch()
    )
    .subscribe();
  return () => {
    supabase.removeChannel(subscription);
  };
}
