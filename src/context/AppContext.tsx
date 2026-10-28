import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useReducer,
  useState,
} from 'react';
import { Alert } from 'react-native';
import { AppAction, AppState, CartItem, Order, Product, Role, Shopper, Theme } from '../types';
import { getUnitPrice, variantKeyOf } from '../utils/variants';
import { loadTheme, saveTheme } from '../utils/storage';
import { supabase } from '../lib/supabase';
import {
  createProduct,
  deleteProduct as deleteProductFromSupabase,
  fetchProducts,
  loadProductsFromCache,
  saveProductsToCache,
  subscribeToProducts,
  updateProduct,
} from '../services/products';
import {
  attachOrderTelegramId,
  createOrder,
  fetchOrders,
  fetchOrdersByTelegramId,
  loadOrdersFromCache,
  saveOrdersToCache,
  subscribeToOrders,
  subscribeToShopperOrders,
  updateOrderItemStatus,
  updateOrderStatus,
} from '../services/orders';
import {
  createCategory,
  deleteCategory,
  fetchCategories,
  loadCategoriesFromCache,
  saveCategoriesToCache,
  subscribeToCategories,
} from '../services/categories';
import { deleteProductImages } from '../services/images';
import { fetchOwnProfile } from '../services/account';
import { getProductCoverImage, getThumbnailUrl } from '../utils/images';
import { Image as ExpoImage } from 'expo-image';
import {
  CACHE_KEYS,
  getCached,
  loadCartFromCache,
  saveCartToCache,
  setCached,
} from '../services/cache';
import { authenticateTelegramShopper } from '../services/telegramAuth';
import { notifyTelegramOrder } from '../services/telegramOrderNotify';
import {
  applyTelegramColors,
  getTelegramInitData,
  isTelegramMiniApp,
} from '../lib/telegram';
import { colors, darkColors } from '../constants/theme';

const initialState: AppState = {
  role: 'user',
  theme: 'light',
  products: [],
  cart: [],
  orders: [],
  categories: [],
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_ROLE':
      return { ...state, role: action.payload };

    case 'SET_THEME':
      return { ...state, theme: action.payload };

    case 'SET_PRODUCTS':
      return { ...state, products: action.payload };

    case 'ADD_PRODUCT':
      return { ...state, products: [action.payload, ...state.products] };

    case 'UPDATE_PRODUCT': {
      const updated = state.products.map((p) =>
        p.id === action.payload.id ? action.payload : p
      );
      return { ...state, products: updated };
    }

    case 'DELETE_PRODUCT':
      return {
        ...state,
        products: state.products.filter((p) => p.id !== action.payload),
      };

    case 'ADD_TO_CART': {
      const { product, selectedImageIndex, variantKey = '', selectedOptions, unitPrice } = action.payload;
      const matchesAdd = (item: (typeof state.cart)[number]) =>
        item.product.id === product.id &&
        item.selectedImageIndex === selectedImageIndex &&
        variantKeyOf(item) === variantKey;
      const existing = state.cart.find(matchesAdd);
      if (existing) {
        return {
          ...state,
          cart: state.cart.map((item) =>
            matchesAdd(item) ? { ...item, quantity: item.quantity + 1 } : item
          ),
        };
      }
      return {
        ...state,
        cart: [
          ...state.cart,
          { product, quantity: 1, selectedImageIndex, selectedOptions, unitPrice },
        ],
      };
    }

    case 'SET_CART':
      return { ...state, cart: action.payload };

    case 'REMOVE_FROM_CART':
      return {
        ...state,
        cart: state.cart.filter(
          (item) =>
            !(
              item.product.id === action.payload.productId &&
              item.selectedImageIndex === action.payload.selectedImageIndex &&
              variantKeyOf(item) === (action.payload.variantKey ?? '')
            )
        ),
      };

    case 'UPDATE_CART_QUANTITY': {
      const { productId, selectedImageIndex, variantKey = '', quantity } = action.payload;
      const matchesQty = (item: (typeof state.cart)[number]) =>
        item.product.id === productId &&
        item.selectedImageIndex === selectedImageIndex &&
        variantKeyOf(item) === variantKey;
      if (quantity <= 0) {
        return {
          ...state,
          cart: state.cart.filter((item) => !matchesQty(item)),
        };
      }
      return {
        ...state,
        cart: state.cart.map((item) =>
          matchesQty(item) ? { ...item, quantity } : item
        ),
      };
    }

    case 'CLEAR_CART':
      return { ...state, cart: [] };

    case 'SET_ORDERS':
      return { ...state, orders: action.payload };

    case 'ADD_ORDER':
      return { ...state, orders: [action.payload, ...state.orders] };

    case 'UPDATE_ORDER':
      return {
        ...state,
        orders: state.orders.map((o) =>
          o.id === action.payload.id ? action.payload : o
        ),
      };

    case 'DELETE_ORDER':
      return {
        ...state,
        orders: state.orders.filter((o) => o.id !== action.payload),
      };

    case 'SET_CATEGORIES':
      return { ...state, categories: action.payload };

    case 'ADD_CATEGORY':
      if (state.categories.includes(action.payload)) return state;
      return { ...state, categories: [...state.categories, action.payload] };

    case 'REMOVE_CATEGORY':
      return {
        ...state,
        categories: state.categories.filter((c) => c !== action.payload),
      };

    default:
      return state;
  }
}

function migrateLegacyProducts(products: Product[]): Product[] {
  return products.map((product) => {
    const legacy = product as Product & { image?: string };
    if (legacy.image && (!legacy.images || legacy.images.length === 0)) {
      return {
        ...legacy,
        images: [legacy.image],
        coverImageIndex: legacy.coverImageIndex ?? 0,
      };
    }
    return product;
  });
}

interface AppContextValue extends AppState {
  currentUserId: string | null;
  shopper: Shopper | null;
  setRole: (role: Role) => void;
  signOutAdmin: () => Promise<void>;
  toggleTheme: () => void;
  addProduct: (product: Product) => Promise<void>;
  updateProduct: (product: Product) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;
  addToCart: (
    product: Product,
    selectedImageIndex?: number,
    selectedOptions?: CartItem['selectedOptions'],
    unitPrice?: number
  ) => void;
  removeFromCart: (productId: string, selectedImageIndex: number, variantKey?: string) => void;
  updateCartQuantity: (
    productId: string,
    selectedImageIndex: number,
    variantKey: string | undefined,
    quantity: number
  ) => void;
  clearCart: () => void;
  addOrder: (order: Order) => Promise<void>;
  updateOrderStatus: (orderId: string, status: Order['status']) => Promise<void>;
  updateOrderItemStatus: (orderId: string, itemKey: string, status: Order['status']) => Promise<void>;
  setCategories: (categories: string[]) => void;
  addCategory: (category: string) => Promise<void>;
  removeCategory: (category: string) => Promise<void>;
  cartTotal: number;
  cartCount: number;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isHydrated, setIsHydrated] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [shopper, setShopper] = useState<Shopper | null>(null);

  useEffect(() => {
    async function hydrate() {
      // Light is the default (initialState); only an explicit user toggle is
      // persisted and restored. We deliberately do NOT follow Telegram's
      // theme inside the Mini App — the shop always opens light unless the
      // user opted into dark.
      const storedTheme = await loadTheme();
      if (storedTheme) {
        dispatch({ type: 'SET_THEME', payload: storedTheme });
      }

      const [cachedProducts, cachedOrders, cachedCategories, cachedCart] = await Promise.all([
        loadProductsFromCache(),
        loadOrdersFromCache(),
        loadCategoriesFromCache(),
        loadCartFromCache(),
      ]);

      const migratedProducts = migrateLegacyProducts(cachedProducts);

      dispatch({ type: 'SET_PRODUCTS', payload: migratedProducts });
      dispatch({ type: 'SET_ORDERS', payload: cachedOrders });
      dispatch({ type: 'SET_CATEGORIES', payload: cachedCategories });
      dispatch({ type: 'SET_CART', payload: cachedCart });

      setIsHydrated(true);

      // Check for an existing admin session.
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.user) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('role, is_active')
            .eq('id', session.user.id)
            .single();
          // A switched-off tenant keeps no session: sign them out instead of
          // restoring the admin role (migration 037).
          if (profile?.role === 'admin' && profile.is_active === false) {
            await supabase.auth.signOut();
          } else if (profile?.role === 'super_admin' || profile?.role === 'admin') {
            setCurrentUserId(session.user.id);
            dispatch({ type: 'SET_ROLE', payload: profile.role });
          } else {
            setCurrentUserId(session.user.id);
          }
        }
      } catch (error) {
        console.error('Failed to restore admin session:', error);
      }

      // Background sync from Supabase. Orders are intentionally NOT fetched
      // here: they are admin-only and handled by the role effect below, so
      // shoppers never download the order history.
      try {
        const [remoteProducts, remoteCategories] = await Promise.all([
          fetchProducts(),
          fetchCategories(),
        ]);

        if (remoteProducts.length > 0) {
          dispatch({ type: 'SET_PRODUCTS', payload: remoteProducts });
          await saveProductsToCache(remoteProducts);
        }

        if (remoteCategories.length > 0) {
          dispatch({ type: 'SET_CATEGORIES', payload: remoteCategories });
          await saveCategoriesToCache(remoteCategories);
        }
      } catch (error) {
        console.error('Failed to sync with Supabase:', error);
      }
    }
    hydrate();
  }, []);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUserId(session?.user?.id ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Shared sign-out routine — also used by the shop on/off realtime kick below.
  async function signOutAdmin() {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Failed to sign out admin:', error);
    }
    setCurrentUserId(null);
    dispatch({ type: 'SET_ROLE', payload: 'user' });
    // Drop the admin order list so it does not leak into shopper mode.
    dispatch({ type: 'SET_ORDERS', payload: [] });
    await saveOrdersToCache([]);
  }

  // Live kick: if the super admin switches this tenant's shop off while they
  // are signed in, their own profile row flips is_active to false — sign them
  // out immediately (migration 037). Only tenants (role 'admin') can be
  // switched off; the super admin is never affected.
  useEffect(() => {
    if (!isHydrated || state.role !== 'admin' || !currentUserId) return;
    const channel = supabase
      .channel(`own-profile-active:${currentUserId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${currentUserId}`,
        },
        (payload) => {
          if ((payload.new as { is_active?: boolean }).is_active === false) {
            Alert.alert(
              'Shop switched off',
              'This shop has been switched off. Please contact the administrator.'
            );
            void signOutAdmin();
          }
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // signOutAdmin only touches stable references (dispatch, supabase).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated, state.role, currentUserId]);

  // Persist cart changes so the cart survives app restarts.
  useEffect(() => {
    if (!isHydrated) return;
    saveCartToCache(state.cart);
  }, [state.cart, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;

    const unsubscribeProducts = subscribeToProducts(async (products) => {
      dispatch({ type: 'SET_PRODUCTS', payload: products });
      await saveProductsToCache(products);
    });

    const unsubscribeCategories = subscribeToCategories(async (categories) => {
      dispatch({ type: 'SET_CATEGORIES', payload: categories });
      await saveCategoriesToCache(categories);
    });

    return () => {
      unsubscribeProducts();
      unsubscribeCategories();
    };
  }, [isHydrated]);

  // Orders are admin-only: fetch once and subscribe to realtime changes only
  // while the role is admin/super_admin. Shoppers keep device-local history
  // (their own placed orders) and never download the global order list.
  // Tenant admins are scoped to orders containing their products (tenant_ids,
  // filled by the stamp_order_tenants trigger); the super admin sees all.
  useEffect(() => {
    if (!isHydrated) return;
    const isAdmin = state.role === 'admin' || state.role === 'super_admin';
    if (!isAdmin) return;
    const tenantFilter = state.role === 'admin' ? currentUserId : undefined;
    // A tenant admin's id comes from the auth session; wait for it so the
    // first fetch is already scoped rather than briefly leaking all orders.
    if (state.role === 'admin' && !tenantFilter) return;

    let unsubscribeOrders: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const orders = await fetchOrders(tenantFilter ?? undefined);
        if (cancelled) return;
        dispatch({ type: 'SET_ORDERS', payload: orders });
        await saveOrdersToCache(orders);
      } catch {
        // Keep cached data if the fetch fails.
      }
      if (!cancelled) {
        unsubscribeOrders = subscribeToOrders(async (orders) => {
          dispatch({ type: 'SET_ORDERS', payload: orders });
          await saveOrdersToCache(orders);
        }, tenantFilter ?? undefined);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeOrders?.();
    };
  }, [isHydrated, state.role, currentUserId]);

  // Telegram Mini App identity: show any cached shopper immediately, then
  // exchange the signed initData for the verified record (works offline on
  // repeat launches because the cached record is used when the call fails).
  useEffect(() => {
    if (!isHydrated || !isTelegramMiniApp()) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function authenticate() {
      const cached = await getCached<Shopper>(CACHE_KEYS.shopper);
      if (cached && !cancelled) setShopper(cached);

      const verified = await authenticateTelegramShopper(getTelegramInitData());
      if (cancelled) return;
      if (verified) {
        setShopper(verified);
        await setCached(CACHE_KEYS.shopper, verified);
      } else if (!cached) {
        // Cold function start or a flaky connection can fail the first
        // exchange; one retry a few seconds later covers it.
        retryTimer = setTimeout(async () => {
          const secondTry = await authenticateTelegramShopper(getTelegramInitData());
          if (cancelled) return;
          if (secondTry) {
            setShopper(secondTry);
            await setCached(CACHE_KEYS.shopper, secondTry);
          }
        }, 5000);
      }
    }

    authenticate();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isHydrated]);

  // A Telegram shopper's order history lives in Supabase (not on the device),
  // so it follows their account across devices. Admins use the admin order
  // list instead, so this stays out of the way while an admin is signed in.
  useEffect(() => {
    if (!isHydrated || !shopper) return;
    if (state.role === 'admin' || state.role === 'super_admin') return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        const orders = await fetchOrdersByTelegramId(shopper.telegramId);
        if (!cancelled) dispatch({ type: 'SET_ORDERS', payload: orders });
      } catch {
        // Keep whatever is already displayed.
      }
      if (!cancelled) {
        unsubscribe = subscribeToShopperOrders(shopper.telegramId, (orders) => {
          dispatch({ type: 'SET_ORDERS', payload: orders });
        });
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isHydrated, shopper, state.role]);

  // Backfill: orders placed before initData validation finished have no
  // telegram_id, and the server-side fetch above replaces local state — so
  // stamp the shopper's id onto them (the RPC only fills a NULL column) as
  // soon as the shopper is known. Fire-and-forget; the orders stay visible
  // locally regardless, and the next server fetch will include them.
  useEffect(() => {
    if (!isHydrated || !shopper) return;
    if (state.role === 'admin' || state.role === 'super_admin') return;
    const unclaimed = state.orders.filter((o) => !o.telegramId);
    if (unclaimed.length === 0) return;
    unclaimed.forEach((order) => {
      attachOrderTelegramId(order.id, shopper.telegramId)
        .then(() => {
          dispatch({
            type: 'UPDATE_ORDER',
            payload: { ...order, telegramId: shopper.telegramId },
          });
        })
        .catch(() => {
          // Still offline etc. — a later launch (or the realtime refetch)
          // will retry this effect once the server fetch no longer overwrites.
        });
    });
    // state.orders changes on every realtime refetch; only the unclaimed
    // subset matters, so re-running extra times is harmless.
  }, [isHydrated, shopper, state.role, state.orders]);

  useEffect(() => {
    if (!isHydrated) return;
    saveTheme(state.theme);
  }, [state.theme, isHydrated]);

  // Warm the image cache: prefetch cover thumbnails (fire-and-forget) so
  // scrolling the catalog on a slow connection finds images already cached
  // instead of starting cold fetches as cards appear.
  useEffect(() => {
    if (!isHydrated) return;
    const urls = state.products
      .slice(0, 60)
      .map((p) => {
        const cover = getProductCoverImage(p);
        return cover ? getThumbnailUrl(cover) : null;
      })
      .filter((u): u is string => !!u);
    if (urls.length === 0) return;
    ExpoImage.prefetch(urls).catch(() => {});
  }, [state.products, isHydrated]);

  // Match the Telegram Mini App chrome (header/background) to the app theme.
  // We intentionally do NOT follow Telegram's own themeChanged events: the
  // app's theme is the user's explicit choice (light by default) and must
  // not be overridden by Telegram's color scheme.
  useEffect(() => {
    if (!isHydrated || !isTelegramMiniApp()) return;
    const palette = state.theme === 'dark' ? darkColors : colors;
    applyTelegramColors(palette.background, palette.background);
  }, [state.theme, isHydrated]);

  const cartTotal = state.cart.reduce(
    (sum, item) => sum + getUnitPrice(item) * item.quantity,
    0
  );
  const cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);

  const value: AppContextValue = {
    ...state,
    currentUserId,
    shopper,
    setRole: (role) => dispatch({ type: 'SET_ROLE', payload: role }),
    signOutAdmin,
    toggleTheme: () =>
      dispatch({ type: 'SET_THEME', payload: state.theme === 'dark' ? 'light' : 'dark' }),
    addProduct: async (product) => {
      const previous = state.products;
      // Stamp the shop identity from the signed-in tenant's own profile so a
      // freshly created product shows the shop name/logo immediately, without
      // waiting for the fetch_products_with_shop refetch. Cheap single-row
      // lookup; failures just fall back to the unstamped product.
      let stamped = product;
      if (state.role === 'admin' && !product.shopName) {
        try {
          const profile = await fetchOwnProfile();
          if (profile) {
            stamped = {
              ...product,
              shopName: profile.shopName ?? undefined,
              ownerShopLogoUrl: profile.shopLogoUrl ?? undefined,
              ownerShopDescription: profile.shopDescription ?? undefined,
              ownerTelegramUsername: profile.telegramUsername ?? undefined,
            };
          }
        } catch {
          // Proceed unstamped; the background refetch fills it in.
        }
      }
      const optimistic = [stamped, ...previous];
      dispatch({ type: 'ADD_PRODUCT', payload: stamped });
      await saveProductsToCache(optimistic);
      try {
        await createProduct(stamped);
      } catch {
        dispatch({ type: 'SET_PRODUCTS', payload: previous });
        await saveProductsToCache(previous);
        throw new Error('Failed to add product');
      }
    },
    updateProduct: async (product) => {
      const previous = state.products;
      const optimistic = previous.map((p) => (p.id === product.id ? product : p));
      dispatch({ type: 'UPDATE_PRODUCT', payload: product });
      await saveProductsToCache(optimistic);
      try {
        await updateProduct(product);
      } catch {
        dispatch({ type: 'SET_PRODUCTS', payload: previous });
        await saveProductsToCache(previous);
        throw new Error('Failed to update product');
      }
    },
    deleteProduct: async (id) => {
      const product = state.products.find((p) => p.id === id);
      const previous = state.products;
      const optimistic = previous.filter((p) => p.id !== id);
      dispatch({ type: 'DELETE_PRODUCT', payload: id });
      await saveProductsToCache(optimistic);
      try {
        await deleteProductFromSupabase(id);
      } catch {
        dispatch({ type: 'SET_PRODUCTS', payload: previous });
        await saveProductsToCache(previous);
        throw new Error('Failed to delete product');
      }
      // Best-effort cleanup of storage objects after the product is gone.
      if (product) {
        deleteProductImages(product.images).catch(() => {});
      }
    },
    addToCart: (product, selectedImageIndex = product.coverImageIndex ?? 0, selectedOptions, unitPrice) => {
      // Free download posts (price 0, migration 044) are never purchasable.
      if (product.price <= 0) return;
      dispatch({
        type: 'ADD_TO_CART',
        payload: {
          product,
          selectedImageIndex,
          variantKey: selectedOptions && selectedOptions.length > 0
            ? variantKeyOf({ selectedOptions })
            : '',
          selectedOptions,
          unitPrice,
        },
      });
    },
    removeFromCart: (productId, selectedImageIndex, variantKey) =>
      dispatch({
        type: 'REMOVE_FROM_CART',
        payload: { productId, selectedImageIndex, variantKey },
      }),
    updateCartQuantity: (productId, selectedImageIndex, variantKey, quantity) =>
      dispatch({
        type: 'UPDATE_CART_QUANTITY',
        payload: { productId, selectedImageIndex, variantKey, quantity },
      }),
    clearCart: () => dispatch({ type: 'CLEAR_CART' }),
    addOrder: async (order) => {
      const previous = state.orders;
      const optimistic = [order, ...previous];
      dispatch({ type: 'ADD_ORDER', payload: order });
      await saveOrdersToCache(optimistic);
      let placed: Order;
      try {
        placed = await createOrder(order);
      } catch {
        dispatch({ type: 'DELETE_ORDER', payload: order.id });
        await saveOrdersToCache(previous);
        throw new Error('Failed to place order');
      }
      if (placed.id !== order.id) {
        // createOrder had to regenerate the code after an id collision; swap
        // the optimistic entry for the order that was actually stored.
        dispatch({ type: 'DELETE_ORDER', payload: order.id });
        dispatch({ type: 'ADD_ORDER', payload: placed });
        await saveOrdersToCache([placed, ...previous]);
      }
      // Fire-and-forget: the Telegram group notification must never block
      // or roll back a successfully placed order.
      notifyTelegramOrder(placed, shopper ?? undefined).catch(() => {});
    },
    updateOrderStatus: async (orderId, status) => {
      const previous = state.orders;
      const target = previous.find((o) => o.id === orderId);
      if (!target) return;
      const updated = { ...target, status };
      const optimistic = previous.map((o) => (o.id === orderId ? updated : o));
      dispatch({ type: 'UPDATE_ORDER', payload: updated });
      await saveOrdersToCache(optimistic);
      try {
        await updateOrderStatus(orderId, status);
      } catch {
        dispatch({ type: 'SET_ORDERS', payload: previous });
        await saveOrdersToCache(previous);
        throw new Error('Failed to update order status');
      }
    },
    updateOrderItemStatus: async (orderId, itemKey, status) => {
      const previous = state.orders;
      const target = previous.find((o) => o.id === orderId);
      if (!target) return;
      const updated: Order = {
        ...target,
        itemStatuses: { ...(target.itemStatuses ?? {}), [itemKey]: status },
      };
      const optimistic = previous.map((o) => (o.id === orderId ? updated : o));
      dispatch({ type: 'UPDATE_ORDER', payload: updated });
      await saveOrdersToCache(optimistic);
      try {
        await updateOrderItemStatus(orderId, itemKey, status);
      } catch {
        dispatch({ type: 'SET_ORDERS', payload: previous });
        await saveOrdersToCache(previous);
        throw new Error('Failed to update item status');
      }
    },
    setCategories: (categories) =>
      dispatch({ type: 'SET_CATEGORIES', payload: categories }),
    addCategory: async (category) => {
      if (state.categories.includes(category)) return;
      const previous = state.categories;
      const optimistic = [...previous, category];
      dispatch({ type: 'ADD_CATEGORY', payload: category });
      await saveCategoriesToCache(optimistic);
      try {
        await createCategory(category);
      } catch {
        dispatch({ type: 'SET_CATEGORIES', payload: previous });
        await saveCategoriesToCache(previous);
        throw new Error('Failed to add category');
      }
    },
    removeCategory: async (category) => {
      const previous = state.categories;
      const optimistic = previous.filter((c) => c !== category);
      dispatch({ type: 'REMOVE_CATEGORY', payload: category });
      await saveCategoriesToCache(optimistic);
      try {
        await deleteCategory(category);
      } catch {
        dispatch({ type: 'SET_CATEGORIES', payload: previous });
        await saveCategoriesToCache(previous);
        throw new Error('Failed to remove category');
      }
    },
    cartTotal,
    cartCount,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
