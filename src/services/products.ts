import { supabase } from '../lib/supabase';
import { debounce } from '../lib/debounce';
import { Product } from '../types';
import { CACHE_KEYS, getCached, setCached } from './cache';

const REFETCH_DEBOUNCE_MS = 500;

interface DbProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  compare_at_price: number | null;
  category: string;
  images: string[];
  cover_image_index: number;
  created_at: string;
  owner_id?: string;
  shop_name?: string | null;
}

function toProduct(db: DbProduct): Product {
  return {
    id: db.id,
    name: db.name,
    description: db.description,
    price: db.price,
    compareAtPrice: db.compare_at_price ?? undefined,
    category: db.category,
    images: db.images,
    coverImageIndex: db.cover_image_index,
    createdAt: db.created_at,
    ownerId: db.owner_id,
    shopName: db.shop_name ?? undefined,
  };
}

function toDbProduct(product: Product): DbProduct {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    compare_at_price: product.compareAtPrice ?? null,
    category: product.category,
    images: product.images,
    cover_image_index: product.coverImageIndex,
    created_at: product.createdAt,
    owner_id: product.ownerId,
  };
}

export async function loadProductsFromCache(): Promise<Product[]> {
  return (await getCached<Product[]>(CACHE_KEYS.products)) ?? [];
}

export async function saveProductsToCache(products: Product[]): Promise<void> {
  await setCached(CACHE_KEYS.products, products);
}

export async function fetchProducts(): Promise<Product[]> {
  // SECURITY DEFINER RPC (migration 017) — products joined with the owner's
  // shop_name, since profiles is not readable by anon clients.
  const { data, error } = await supabase.rpc('fetch_products_with_shop');
  if (error) throw error;
  return (data ?? []).map(toProduct);
}

export async function createProduct(product: Product): Promise<Product> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const dbProduct = toDbProduct(product);
  if (!dbProduct.owner_id && user?.id) {
    dbProduct.owner_id = user.id;
  }

  const { error } = await supabase.from('products').insert(dbProduct);
  if (error) throw error;
  return product;
}

export async function updateProduct(product: Product): Promise<Product> {
  const { error } = await supabase
    .from('products')
    .update(toDbProduct(product))
    .eq('id', product.id);
  if (error) throw error;
  return product;
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

export async function seedProducts(products: Product[]): Promise<void> {
  if (products.length === 0) return;
  const { error } = await supabase.from('products').upsert(products.map(toDbProduct));
  if (error) throw error;
}

export function subscribeToProducts(onChange: (products: Product[]) => void) {
  // Debounce so a burst of events (e.g. a multi-image upload) triggers one refetch.
  const refetch = debounce(async () => {
    try {
      const products = await fetchProducts();
      onChange(products);
    } catch {
      // Keep cached data if the refresh fails.
    }
  }, REFETCH_DEBOUNCE_MS);

  const subscription = supabase
    .channel('products_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'products' },
      () => refetch()
    )
    .subscribe();
  return () => {
    supabase.removeChannel(subscription);
  };
}
