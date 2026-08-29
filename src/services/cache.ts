import AsyncStorage from '@react-native-async-storage/async-storage';

export const CACHE_KEYS = {
  products: '@onlineshop_products',
  orders: '@onlineshop_orders',
  categories: '@onlineshop_categories',
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
