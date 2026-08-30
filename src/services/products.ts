import { supabase } from '../lib/supabase';
import { Product } from '../types';
import { CACHE_KEYS, getCached, setCached } from './cache';

interface DbProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  images: string[];
  cover_image_index: number;
  created_at: string;
  owner_id?: string;
}

function toProduct(db: DbProduct): Product {
  return {
    id: db.id,
    name: db.name,
    description: db.description,
    price: db.price,
    category: db.category,
    images: db.images,
    coverImageIndex: db.cover_image_index,
    createdAt: db.created_at,
    ownerId: db.owner_id,
  };
}

function toDbProduct(product: Product): DbProduct {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
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
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });
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
  const subscription = supabase
    .channel('products_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'products' },
      async () => {
        try {
          const products = await fetchProducts();
          onChange(products);
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
