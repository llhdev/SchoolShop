import { Platform, ActivityIndicator, View } from 'react-native';
import { ComponentType, lazy, Suspense } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { UserTabParamList } from '../types/navigation';
import { HomeScreen } from '../screens/user/HomeScreen';
import { useApp } from '../context/AppContext';
import { useThemeColors } from '../constants/theme';

const Tab = createBottomTabNavigator<UserTabParamList>();

// Cart and Orders are split out of the initial bundle (web); Home stays eager
// because it is the landing route.
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

const CartScreen = lazyScreen(() =>
  import('../screens/user/CartScreen').then((m) => ({ default: m.CartScreen }))
);
const OrdersScreen = lazyScreen(() =>
  import('../screens/user/OrdersScreen').then((m) => ({ default: m.OrdersScreen }))
);

export function UserTabNavigator() {
  const { cartCount } = useApp();
  const colors = useThemeColors();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          height: Platform.OS === 'web' ? 56 : 50,
          paddingBottom: Platform.OS === 'web' ? 8 : 4,
          paddingTop: 0,
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          lineHeight: 12,
          marginTop: 0,
        },
        tabBarIconStyle: {
          marginBottom: 0,
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Cart"
        component={CartScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="cart-outline" size={size} color={color} />
          ),
          tabBarBadge: cartCount > 0 ? (cartCount > 99 ? '99+' : cartCount) : undefined,
        }}
      />
      <Tab.Screen
        name="Orders"
        component={OrdersScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list-outline" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
