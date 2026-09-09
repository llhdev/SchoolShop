import { ActivityIndicator, Platform, View } from 'react-native';
import { ComponentType, lazy, Suspense, useEffect } from 'react';
import {
  getPathFromState as defaultGetPathFromState,
  getStateFromPath as defaultGetStateFromPath,
  LinkingOptions,
  NavigationContainer,
  NavigationContainerRefWithCurrent,
  useNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useApp } from '../context/AppContext';
import { UserTabNavigator } from './UserTabNavigator';
import { getTelegram, hasTelegramChrome, isTelegramMiniApp } from '../lib/telegram';

// Screens below the fold are code-split on web: Metro emits them as separate
// chunks so the initial bundle (what a 3G shopper downloads on first load)
// only carries the home/catalog path. Native falls back through the same
// lazy mechanism (React.lazy just needs a thenable factory).
function lazyScreen<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  const Lazy = lazy(factory);
  return function LazyScreen(props: any) {
    return (
      <Suspense
        fallback={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" />
          </View>
        }
      >
        <Lazy {...props} />
      </Suspense>
    );
  };
}

const AdminStackNavigator = lazyScreen(() =>
  import('./AdminStackNavigator').then((m) => ({ default: m.AdminStackNavigator }))
);
const ProductDetailScreen = lazyScreen(() =>
  import('../screens/user/ProductDetailScreen').then((m) => ({ default: m.ProductDetailScreen }))
);
const CheckoutScreen = lazyScreen(() =>
  import('../screens/user/CheckoutScreen').then((m) => ({ default: m.CheckoutScreen }))
);
const OrderDetailScreen = lazyScreen(() =>
  import('../screens/user/OrderDetailScreen').then((m) => ({ default: m.OrderDetailScreen }))
);
const AdminLoginScreen = lazyScreen(() =>
  import('../screens/AdminLoginScreen').then((m) => ({ default: m.AdminLoginScreen }))
);

const Stack = createNativeStackNavigator<RootStackParamList>();

// GitHub Pages serves the Mini App from the /SchoolShop subpath (matches
// app.json experiments.baseUrl). Deep links arrive with that prefix, so
// strip it before matching routes. On a root-hosted website the replace is
// a no-op.
const WEB_BASE_PATH = '/SchoolShop';

const linking: LinkingOptions<RootStackParamList> | undefined =
  Platform.OS === 'web'
    ? {
        prefixes:
          typeof window !== 'undefined'
            ? [`${window.location.origin}${WEB_BASE_PATH}`]
            : [],
        config: {
          screens: {
            UserTabs: {
              initialRouteName: 'Home',
              screens: {
                Home: '',
                Cart: 'cart',
                Orders: 'orders',
              },
            },
            ProductDetail: 'product/:productId',
            Checkout: 'checkout',
            OrderDetail: 'order/:orderId',
          },
        },
        getStateFromPath: (path, options) =>
          defaultGetStateFromPath(
            path.replace(new RegExp(`^${WEB_BASE_PATH}(?=/|$)`), '') || '/',
            options
          ),
        getPathFromState: (state, options) =>
          defaultGetPathFromState(state, options),
      }
    : undefined;

/**
 * Inside the Mini App, Telegram's native BackButton replaces the React
 * Navigation header back arrow (both would draw top-left and overlap).
 * Show it whenever the stack can go back; hide it at the root.
 */
function TelegramBackButton({
  navigationRef,
}: {
  navigationRef: NavigationContainerRefWithCurrent<RootStackParamList>;
}) {
  useEffect(() => {
    if (!isTelegramMiniApp()) return;
    const webApp = getTelegram();
    if (!webApp) return;

    const onPress = () => {
      if (navigationRef.canGoBack()) navigationRef.goBack();
    };
    const sync = () => {
      if (navigationRef.canGoBack()) webApp.BackButton.show();
      else webApp.BackButton.hide();
    };

    webApp.BackButton.onClick(onPress);
    const unsubscribe = navigationRef.addListener('state', sync);
    sync();

    return () => {
      webApp.BackButton.offClick(onPress);
      unsubscribe();
      webApp.BackButton.hide();
    };
  }, [navigationRef]);

  return null;
}

export function AppNavigator() {
  const { role } = useApp();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  // In the Mini App the RN header is hidden when Telegram's native BackButton
  // is available; with a stub WebApp (SDK failed to load) the RN header is the
  // only way back.
  const showHeader = !isTelegramMiniApp() || !hasTelegramChrome();

  return (
    <NavigationContainer ref={navigationRef} linking={linking}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isAdmin ? (
          <>
            <Stack.Screen name="AdminStack" component={AdminStackNavigator} />
            <Stack.Screen
              name="ProductDetail"
              component={ProductDetailScreen}
              options={{ headerShown: showHeader, title: 'Product' }}
            />
            <Stack.Screen
              name="OrderDetail"
              component={OrderDetailScreen}
              options={{ headerShown: showHeader, title: 'Order Details' }}
            />
          </>
        ) : (
          <>
            <Stack.Screen name="UserTabs" component={UserTabNavigator} />
            <Stack.Screen
              name="ProductDetail"
              component={ProductDetailScreen}
              options={{ headerShown: showHeader, title: 'Product' }}
            />
            <Stack.Screen
              name="Checkout"
              component={CheckoutScreen}
              options={{ headerShown: showHeader, title: 'Checkout' }}
            />
            <Stack.Screen
              name="OrderDetail"
              component={OrderDetailScreen}
              options={{ headerShown: showHeader, title: 'Order Details' }}
            />
            <Stack.Screen
              name="AdminLogin"
              component={AdminLoginScreen}
              options={{ headerShown: showHeader, title: 'Admin Login' }}
            />
          </>
        )}
      </Stack.Navigator>
      <TelegramBackButton navigationRef={navigationRef} />
    </NavigationContainer>
  );
}
