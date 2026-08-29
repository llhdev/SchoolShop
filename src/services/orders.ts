import { supabase } from '../lib/supabase';
import { Order } from '../types';
import { CACHE_KEYS, getCached, setCached } from './cache';

interface DbOrder {
  id: string;
  items: unknown;
  total: number;
  payment_method: string;
  status: string;
  location: string;
  phone_number: string;
  created_at: string;
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

export async function createOrder(order: Order): Promise<Order> {
  const { error } = await supabase.from('orders').insert(toDbOrder(order));
  if (error) throw error;
  return order;
}

export function subscribeToOrders(onChange: (orders: Order[]) => void) {
  const subscription = supabase
    .channel('orders_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'orders' },
      async () => {
        try {
          const orders = await fetchOrders();
          onChange(orders);
        } catch {
          // Keep cached data if the refresh fails.
        }
      }
    )
    .subscribe();
  return () => {
    supabase.removeChannel(subscription);
  };
}
