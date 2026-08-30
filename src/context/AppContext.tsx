import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useReducer,
  useState,
} from 'react';
import { AppAction, AppState, CartItem, Order, Product, Role, Theme } from '../types';
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
  createOrder,
  fetchOrders,
  loadOrdersFromCache,
  saveOrdersToCache,
  subscribeToOrders,
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
      const { product, selectedImageIndex } = action.payload;
      const existing = state.cart.find(
        (item) =>
          item.product.id === product.id &&
          item.selectedImageIndex === selectedImageIndex
      );
      if (existing) {
        return {
          ...state,
          cart: state.cart.map((item) =>
            item.product.id === product.id &&
            item.selectedImageIndex === selectedImageIndex
              ? { ...item, quantity: item.quantity + 1 }
              : item
          ),
        };
      }
      return {
        ...state,
        cart: [
          ...state.cart,
          { product, quantity: 1, selectedImageIndex },
        ],
      };
    }

    case 'REMOVE_FROM_CART':
      return {
        ...state,
        cart: state.cart.filter(
          (item) =>
            !(
              item.product.id === action.payload.productId &&
              item.selectedImageIndex === action.payload.selectedImageIndex
            )
        ),
      };

    case 'UPDATE_CART_QUANTITY': {
      const { productId, selectedImageIndex, quantity } = action.payload;
      if (quantity <= 0) {
        return {
          ...state,
          cart: state.cart.filter(
            (item) =>
              !(
                item.product.id === productId &&
                item.selectedImageIndex === selectedImageIndex
              )
          ),
        };
      }
      return {
        ...state,
        cart: state.cart.map((item) =>
          item.product.id === productId &&
          item.selectedImageIndex === selectedImageIndex
            ? { ...item, quantity }
            : item
        ),
      };
    }

    case 'CLEAR_CART':
      return { ...state, cart: [] };

    case 'SET_ORDERS':
      return { ...state, orders: action.payload };

    case 'ADD_ORDER':
      return { ...state, orders: [action.payload, ...state.orders] };

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
  setRole: (role: Role) => void;
  signOutAdmin: () => Promise<void>;
  toggleTheme: () => void;
  addProduct: (product: Product) => Promise<void>;
  updateProduct: (product: Product) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;
  addToCart: (product: Product, selectedImageIndex?: number) => void;
  removeFromCart: (productId: string, selectedImageIndex: number) => void;
  updateCartQuantity: (
    productId: string,
    selectedImageIndex: number,
    quantity: number
  ) => void;
  clearCart: () => void;
  addOrder: (order: Order) => Promise<void>;
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

  useEffect(() => {
    async function hydrate() {
      const storedTheme = await loadTheme();
      if (storedTheme) {
        dispatch({ type: 'SET_THEME', payload: storedTheme });
      }

      const [cachedProducts, cachedOrders, cachedCategories] = await Promise.all([
        loadProductsFromCache(),
        loadOrdersFromCache(),
        loadCategoriesFromCache(),
      ]);

      const migratedProducts = migrateLegacyProducts(cachedProducts);

      dispatch({ type: 'SET_PRODUCTS', payload: migratedProducts });
      dispatch({ type: 'SET_ORDERS', payload: cachedOrders });
      dispatch({ type: 'SET_CATEGORIES', payload: cachedCategories });

      setIsHydrated(true);

      // Check for an existing admin session.
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.user) {
          setCurrentUserId(session.user.id);
          const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', session.user.id)
            .single();
          if (profile?.role === 'super_admin' || profile?.role === 'admin') {
            dispatch({ type: 'SET_ROLE', payload: profile.role });
          }
        }
      } catch (error) {
        console.error('Failed to restore admin session:', error);
      }

      // Background sync from Supabase.
      try {
        const [remoteProducts, remoteOrders, remoteCategories] = await Promise.all([
          fetchProducts(),
          fetchOrders(),
          fetchCategories(),
        ]);

        if (remoteProducts.length > 0) {
          dispatch({ type: 'SET_PRODUCTS', payload: remoteProducts });
          await saveProductsToCache(remoteProducts);
        }

        dispatch({ type: 'SET_ORDERS', payload: remoteOrders });
        await saveOrdersToCache(remoteOrders);

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

  useEffect(() => {
    if (!isHydrated) return;

    const unsubscribeProducts = subscribeToProducts(async (products) => {
      dispatch({ type: 'SET_PRODUCTS', payload: products });
      await saveProductsToCache(products);
    });

    const unsubscribeOrders = subscribeToOrders(async (orders) => {
      dispatch({ type: 'SET_ORDERS', payload: orders });
      await saveOrdersToCache(orders);
    });

    const unsubscribeCategories = subscribeToCategories(async (categories) => {
      dispatch({ type: 'SET_CATEGORIES', payload: categories });
      await saveCategoriesToCache(categories);
    });

    return () => {
      unsubscribeProducts();
      unsubscribeOrders();
      unsubscribeCategories();
    };
  }, [isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    saveTheme(state.theme);
  }, [state.theme, isHydrated]);

  const cartTotal = state.cart.reduce(
    (sum, item) => sum + item.product.price * item.quantity,
    0
  );
  const cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);

  const value: AppContextValue = {
    ...state,
    currentUserId,
    setRole: (role) => dispatch({ type: 'SET_ROLE', payload: role }),
    signOutAdmin: async () => {
      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.error('Failed to sign out admin:', error);
      }
      setCurrentUserId(null);
      dispatch({ type: 'SET_ROLE', payload: 'user' });
    },
    toggleTheme: () =>
      dispatch({ type: 'SET_THEME', payload: state.theme === 'dark' ? 'light' : 'dark' }),
    addProduct: async (product) => {
      const previous = state.products;
      const optimistic = [product, ...previous];
      dispatch({ type: 'ADD_PRODUCT', payload: product });
      await saveProductsToCache(optimistic);
      try {
        await createProduct(product);
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
        if (product) {
          // Best-effort cleanup of storage objects; do not block product deletion.
          await deleteProductImages(product.images).catch(() => {});
        }
        await deleteProductFromSupabase(id);
      } catch {
        dispatch({ type: 'SET_PRODUCTS', payload: previous });
        await saveProductsToCache(previous);
        throw new Error('Failed to delete product');
      }
    },
    addToCart: (product, selectedImageIndex = product.coverImageIndex ?? 0) =>
      dispatch({
        type: 'ADD_TO_CART',
        payload: { product, selectedImageIndex },
      }),
    removeFromCart: (productId, selectedImageIndex) =>
      dispatch({
        type: 'REMOVE_FROM_CART',
        payload: { productId, selectedImageIndex },
      }),
    updateCartQuantity: (productId, selectedImageIndex, quantity) =>
      dispatch({
        type: 'UPDATE_CART_QUANTITY',
        payload: { productId, selectedImageIndex, quantity },
      }),
    clearCart: () => dispatch({ type: 'CLEAR_CART' }),
    addOrder: async (order) => {
      const previous = state.orders;
      const optimistic = [order, ...previous];
      dispatch({ type: 'ADD_ORDER', payload: order });
      await saveOrdersToCache(optimistic);
      try {
        await createOrder(order);
      } catch {
        dispatch({ type: 'DELETE_ORDER', payload: order.id });
        await saveOrdersToCache(previous);
        throw new Error('Failed to place order');
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
