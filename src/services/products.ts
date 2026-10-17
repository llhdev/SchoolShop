import { supabase } from '../lib/supabase';
import { debounce } from '../lib/debounce';
import { BankAccount, Product } from '../types';
import { toDbVariantGroups, toVariantGroups } from '../utils/variants';
import { toCheckoutFields, toDbCheckoutFields } from '../utils/checkoutFields';
import { CACHE_KEYS, getCached, setCached } from './cache';

const REFETCH_DEBOUNCE_MS = 500;

interface DbBankAccount {
  account_number?: string | null;
  bank_name?: string | null;
  qr_image_url?: string | null;
}

function toBankAccounts(db: unknown): BankAccount[] {
  if (!Array.isArray(db)) return [];
  return db
    .map((entry): BankAccount | null => {
      const raw = entry as DbBankAccount;
      if (!raw?.account_number) return null;
      return {
        accountNumber: raw.account_number,
        bankName: raw.bank_name ?? undefined,
        qrImageUrl: raw.qr_image_url ?? undefined,
      };
    })
    .filter((a): a is BankAccount => a !== null);
}

interface DbProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  compare_at_price: number | null;
  category: string;
  images: string[];
  detail_images?: string[] | null;
  cover_image_index: number;
  price_hidden?: boolean | null;
  order_count?: number | null;
  created_at: string;
  owner_id?: string;
  shop_name?: string | null;
  bank_accounts?: unknown;
  shipping_fee?: number | null;
  shop_logo_url?: string | null;
  shop_description?: string | null;
  telegram_username?: string | null;
  payment_verification_enabled?: boolean | null;
  variants?: unknown;
  checkout_fields?: unknown;
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
    detailImages: db.detail_images ?? undefined,
    coverImageIndex: db.cover_image_index,
    priceHidden: db.price_hidden ?? undefined,
    orderCount: db.order_count ?? 0,
    createdAt: db.created_at,
    ownerId: db.owner_id,
    shopName: db.shop_name ?? undefined,
    ownerBankAccounts: toBankAccounts(db.bank_accounts),
    ownerShippingFee: db.shipping_fee ?? undefined,
    ownerShopLogoUrl: db.shop_logo_url ?? undefined,
    ownerShopDescription: db.shop_description ?? undefined,
    ownerTelegramUsername: db.telegram_username ?? undefined,
    ownerPaymentVerificationEnabled: db.payment_verification_enabled ?? undefined,
    variantGroups: toVariantGroups(db.variants),
    checkoutFields: toCheckoutFields(db.checkout_fields),
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
    detail_images: product.detailImages ?? [],
    cover_image_index: product.coverImageIndex,
    price_hidden: product.priceHidden ?? false,
    order_count: product.orderCount ?? 0,
    created_at: product.createdAt,
    owner_id: product.ownerId,
    variants: toDbVariantGroups(product.variantGroups),
    checkout_fields: toDbCheckoutFields(product.checkoutFields),
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
