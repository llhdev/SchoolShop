import { supabase } from '../lib/supabase';
import { debounce } from '../lib/debounce';
import { Order } from '../types';
import { generateOrderCode } from '../utils/orderCode';
import { CACHE_KEYS, getCached, setCached } from './cache';

const REFETCH_DEBOUNCE_MS = 500;

interface DbOrder {
  id: string;
  items: unknown;
  total: number;
  payment_method: string;
  status: string;
  location: string;
  phone_number: string;
  created_at: string;
  telegram_id: number | null;
}

function toOrder(db: DbOrder): Order {
  return {
    id: db.id,
    items: db.items as Order['items'],
    total: db.total,
    paymentMethod: db.payment_method as Order['paymentMethod'],
    status: db.status as Order['status'],
    location: db.location,
    phoneNumber: db.phone_number,
    createdAt: db.created_at,
    telegramId: db.telegram_id ?? undefined,
  };
}

function toDbOrder(order: Order): DbOrder {
  return {
    id: order.id,
    items: order.items,
    total: order.total,
    payment_method: order.paymentMethod,
    status: order.status,
    location: order.location,
    phone_number: order.phoneNumber,
    created_at: order.createdAt,
    telegram_id: order.telegramId ?? null,
  };
}

export async function loadOrdersFromCache(): Promise<Order[]> {
  return (await getCached<Order[]>(CACHE_KEYS.orders)) ?? [];
}

export async function saveOrdersToCache(orders: Order[]): Promise<void> {
  await setCached(CACHE_KEYS.orders, orders);
}

export async function fetchOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toOrder);
}

/** Orders placed by one Telegram shopper, newest first. */
export async function fetchOrdersByTelegramId(telegramId: number): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('telegram_id', telegramId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toOrder);
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

/** Super-admin status transition (pending/paid -> completed/failed). */
export async function updateOrderStatus(id: string, status: Order['status']): Promise<void> {
  const { error } = await supabase.from('orders').update({ status }).eq('id', id);
  if (error) throw error;
}

export function subscribeToOrders(onChange: (orders: Order[]) => void) {
  // Debounce so a burst of events triggers one refetch.
  const refetch = debounce(async () => {
    try {
      const orders = await fetchOrders();
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
