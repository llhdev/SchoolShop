import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useApp } from '../context/AppContext';
import { UserTabNavigator } from './UserTabNavigator';
import { AdminStackNavigator } from './AdminStackNavigator';
import { ProductDetailScreen } from '../screens/user/ProductDetailScreen';
import { CheckoutScreen } from '../screens/user/CheckoutScreen';
import { OrderDetailScreen } from '../screens/user/OrderDetailScreen';
import { AdminLoginScreen } from '../screens/AdminLoginScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function AppNavigator() {
  const { role } = useApp();

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {role === 'admin' ? (
          <>
            <Stack.Screen name="AdminStack" component={AdminStackNavigator} />
            <Stack.Screen
              name="ProductDetail"
              component={ProductDetailScreen}
              options={{ headerShown: true, title: 'Product' }}
            />
            <Stack.Screen
              name="OrderDetail"
              component={OrderDetailScreen}
              options={{ headerShown: true, title: 'Order Details' }}
            />
          </>
        ) : (
          <>
            <Stack.Screen name="UserTabs" component={UserTabNavigator} />
            <Stack.Screen
              name="ProductDetail"
              component={ProductDetailScreen}
              options={{ headerShown: true, title: 'Product' }}
            />
            <Stack.Screen
              name="Checkout"
              component={CheckoutScreen}
              options={{ headerShown: true, title: 'Checkout' }}
            />
            <Stack.Screen
              name="OrderDetail"
              component={OrderDetailScreen}
              options={{ headerShown: true, title: 'Order Details' }}
            />
            <Stack.Screen
              name="AdminLogin"
              component={AdminLoginScreen}
              options={{ headerShown: true, title: 'Admin Login' }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
