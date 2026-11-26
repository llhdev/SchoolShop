import { supabase } from '../lib/supabase';
import { debounce } from '../lib/debounce';
import { CancelRemark, CartItem, Order, OrderStatus, PaymentWarning } from '../types';
import { generateOrderCode } from '../utils/orderCode';
import { getCartItemLineId } from '../utils/variants';
import { CACHE_KEYS, getCached, setCached } from './cache';

const REFETCH_DEBOUNCE_MS = 500;

/** Shopper status polling cadence. Realtime order events no longer reach
 *  anonymous clients (062 — the public SELECT policy was dropped), so guest
 *  and Mini App order lists poll on this interval instead; 15s is quick
 *  enough that a payment verified right after checkout shows up while the
 *  shopper is still looking at the screen. */
const SHOPPER_POLL_MS = 15000;

export interface DbOrder {
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
  payment_warnings: Record<string, PaymentWarning> | null;
  cancel_remarks: Record<string, CancelRemark> | null;
}

export function toOrder(db: DbOrder): Order {
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
    paymentWarnings: db.payment_warnings ?? undefined,
    cancelRemarks: db.cancel_remarks ?? undefined,
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
    payment_warnings: order.paymentWarnings ?? {},
    cancel_remarks: order.cancelRemarks ?? {},
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
 *  tenant_ids is filled server-side by the stamp_order_tenants trigger.
 *  The direct table read is super-admin/financial-only (migration 064);
 *  staff without the Financial capability get no context order cache at all
 *  (their screens use the set-based 070/071 RPCs — the 064 get_scoped_orders
 *  loop times out on large shops). */
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

/** Single order by id, direct table read — super admin / financial staff only
 *  (the 064 SELECT policy rejects everyone else). OrderDetail uses this as a
 *  fallback when the order isn't in context; money-blind staff go through
 *  fetchScopedOrder (get_scoped_order RPC, migration 070) instead. */
export async function fetchOrderById(orderId: string): Promise<Order | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  return data ? toOrder(data as unknown as DbOrder) : null;
}

/** Line items of an order that belong to one tenant. Item snapshots are
 *  stamped with product.owner_id by the DB trigger; fall back to the
 *  client-side camelCase ownerId for rows written before the trigger.
 *  Items with a missing product snapshot (malformed rows) are skipped —
 *  one poisoned item must not crash every order screen (no error boundary
 *  used to catch this). */
export function getOrderItemsForTenant(order: Order, tenantId: string): Order['items'] {
  return order.items.filter((item) => {
    const product = item.product as { owner_id?: string; ownerId?: string } | null | undefined;
    if (!product) return false;
    return product.owner_id === tenantId || product.ownerId === tenantId;
  });
}

/** Line items visible to one staff account: the tenant's items, further
 *  narrowed to one branch for branch-scoped staff (migration 045). When the
 *  shop's checkout branch selection is off (046), orders carry no branch
 *  stamp, so branch-scoped staff see the whole shop instead. Unstamped items
 *  (053 — orders from before the shop had branches) are shop-wide too: only
 *  items stamped with a DIFFERENT branch are hidden. Mirrors
 *  update_order_item_status. */
export function getOrderItemsForScope(
  order: Order,
  tenantId: string,
  branchId?: string | null,
  branchSelectionEnabled = true
): Order['items'] {
  const items = getOrderItemsForTenant(order, tenantId);
  if (!branchId || !branchSelectionEnabled) return items;
  return items.filter((item) => item.branchId == null || item.branchId === branchId);
}

/** Orders placed by one Telegram shopper, newest first. Goes through the
 *  get_orders_by_telegram_id RPC (migration 062): orders are no longer
 *  publicly readable, so the caller must present the ordersToken issued by
 *  telegram-auth. A missing token (shopper cached before 062) returns [] —
 *  the next telegram-auth refresh repopulates it. */
export async function fetchOrdersByTelegramId(
  telegramId: number,
  ordersToken?: string
): Promise<Order[]> {
  if (!ordersToken) return [];
  const { data, error } = await supabase.rpc('get_orders_by_telegram_id', {
    p_telegram_id: telegramId,
    p_token: ordersToken,
  });
  if (error) throw error;
  return ((data ?? []) as unknown as DbOrder[]).map(toOrder);
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
 *  initData validation finished (telegram_id is still NULL). Since migration
 *  062 the RPC also requires the order's phone number — knowing the order id
 *  alone no longer lets anyone claim an order. No-op if the order already
 *  belongs to someone or the phone does not match. */
export async function attachOrderTelegramId(
  orderId: string,
  telegramId: number,
  phone: string
): Promise<void> {
  const { error } = await supabase.rpc('attach_order_telegram_id', {
    p_order_id: orderId,
    p_telegram_id: telegramId,
    p_phone: phone,
  });
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

/** True while an order carries an unresolved payment-verification warning for
 *  a tenant (migration 056 soft-launch): the warning exists and the tenant
 *  still has items awaiting payment. The tag hides itself once every warned
 *  item leaves pending/received — auto-payed verifications and manual
 *  mark-paid both clear it without any extra writes. Pass null as tenantId
 *  (super admin) to match any tenant's warning. */
export function hasPaymentWarning(order: Order, tenantId: string | null): boolean {
  const warnings = order.paymentWarnings;
  if (!warnings) return false;
  const tenantIds = tenantId
    ? warnings[tenantId]
      ? [tenantId]
      : []
    : Object.keys(warnings);
  if (tenantIds.length === 0) return false;
  return order.items.some((item) => {
    const product = item.product as { owner_id?: string; ownerId?: string } | null | undefined;
    const owner = product?.owner_id ?? product?.ownerId;
    if (!owner || !tenantIds.includes(owner)) return false;
    const status = getItemStatus(order, item);
    return status === 'pending' || status === 'received';
  });
}

/** Set the status of a single line item. Enforced server-side: super admin or
 *  the tenant that owns the item (migration 022 RPC). Cancelling REQUIRES a
 *  reason (072) — pass the preset label in cancelReason plus the free-text
 *  detail when the preset is 'Other'. */
export async function updateOrderItemStatus(
  orderId: string,
  itemKey: string,
  status: OrderStatus,
  cancelReason?: string,
  cancelDetail?: string
): Promise<void> {
  const { error } = await supabase.rpc('update_order_item_status', {
    p_order_id: orderId,
    p_item_key: itemKey,
    p_status: status,
    ...(status === 'cancelled'
      ? { p_cancel_reason: cancelReason ?? null, p_cancel_detail: cancelDetail ?? null }
      : {}),
  });
  if (error) throw error;
}

export function subscribeToOrders(
  onChange: (orders: Order[]) => void,
  tenantId?: string
) {
  // Debounce so a burst of events triggers one refetch. Only table readers
  // (super admin / financial staff) subscribe — money-blind staff have no
  // context order cache to refresh.
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

/** Orders by id, newest-first NOT guaranteed (callers re-sort). Used by
 *  guest shoppers, whose history is a device-local cache of the orders they
 *  placed: refetching exactly those orders is what lets their status (admin
 *  changes, auto-payment-verification) update after checkout. Since migration
 *  062 orders are no longer publicly readable, so each fetch goes through
 *  get_order_for_shopper and must present the order's phone number — the
 *  shopper typed it at checkout and the local cache keeps it. Orders whose
 *  cached phone is empty (placed before phone became required) are skipped:
 *  the server can never match them. */
export async function fetchOrdersByIds(
  refs: { id: string; phone: string }[]
): Promise<Order[]> {
  const all: Order[] = [];
  await Promise.all(
    refs
      .filter((ref) => ref.phone.trim().length > 0)
      .map(async (ref) => {
        const { data, error } = await supabase.rpc('get_order_for_shopper', {
          p_order_id: ref.id,
          p_phone: ref.phone,
        });
        if (error) throw error;
        all.push(...((data ?? []) as unknown as DbOrder[]).map(toOrder));
      })
  );
  return all;
}

/** Live status for one shopper's orders (Telegram Mini App sessions). Since
 *  migration 062 anonymous clients receive no order row events, so the
 *  realtime subscription below almost never fires — the actual mechanism is
 *  the SHOPPER_POLL_MS interval, which refetches via get_orders_by_telegram_id
 *  (the HMAC token is the capability). */
export function subscribeToShopperOrders(
  telegramId: number,
  ordersToken: string | undefined,
  onChange: (orders: Order[]) => void
) {
  const refetch = debounce(async () => {
    try {
      const orders = await fetchOrdersByTelegramId(telegramId, ordersToken);
      onChange(orders);
    } catch {
      // Keep cached data if the refresh fails.
    }
  }, REFETCH_DEBOUNCE_MS);

  const poller = setInterval(refetch, SHOPPER_POLL_MS);
  const subscription = supabase
    .channel(`orders_shopper_${telegramId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'orders' },
      () => refetch()
    )
    .subscribe();
  return () => {
    clearInterval(poller);
    supabase.removeChannel(subscription);
  };
}

/** Live status for a guest shopper: refetch exactly the orders this device
 *  knows about (id + the phone typed at checkout, via get_order_for_shopper).
 *  Same 062 caveat as subscribeToShopperOrders — polling, not realtime, is
 *  what keeps guest statuses in sync with the admin side. */
export function subscribeToOrdersByIds(
  refs: { id: string; phone: string }[],
  onChange: (orders: Order[]) => void
) {
  const refetch = debounce(async () => {
    try {
      const orders = await fetchOrdersByIds(refs);
      onChange(orders);
    } catch {
      // Keep cached data if the refresh fails.
    }
  }, REFETCH_DEBOUNCE_MS);

  const poller = setInterval(refetch, SHOPPER_POLL_MS);
  const subscription = supabase
    .channel('orders_guest')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'orders' },
      () => refetch()
    )
    .subscribe();
  return () => {
    clearInterval(poller);
    supabase.removeChannel(subscription);
  };
}
