import AsyncStorage from '@react-native-async-storage/async-storage';
import { CartItem } from '../types';

export const CACHE_KEYS = {
  products: '@schoolshop_products',
  orders: '@schoolshop_orders',
  categories: '@schoolshop_categories',
  cart: '@schoolshop_cart',
} as const;

export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const json = await AsyncStorage.getItem(key);
    return json ? (JSON.parse(json) as T) : null;
  } catch {
    return null;
  }
}

export async function setCached<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export async function loadCartFromCache(): Promise<CartItem[]> {
  return (await getCached<CartItem[]>(CACHE_KEYS.cart)) ?? [];
}

export async function saveCartToCache(cart: CartItem[]): Promise<void> {
  await setCached(CACHE_KEYS.cart, cart);
}
