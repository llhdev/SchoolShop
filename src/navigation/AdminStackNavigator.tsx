import { Platform } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AdminStackParamList } from '../types/navigation';
import { AdminDashboardScreen } from '../screens/admin/AdminDashboardScreen';
import { AddEditItemScreen } from '../screens/admin/AddEditItemScreen';
import { AdminOrdersScreen } from '../screens/admin/AdminOrdersScreen';
import { AdminUserOrdersScreen } from '../screens/admin/AdminUserOrdersScreen';
import { TenantManagementScreen } from '../screens/admin/TenantManagementScreen';
import { TenantDetailScreen } from '../screens/admin/TenantDetailScreen';
import { useThemeColors, fontSizes } from '../constants/theme';

const Stack = createNativeStackNavigator<AdminStackParamList>();

export function AdminStackNavigator() {
  const colors = useThemeColors();

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: Platform.OS !== 'web',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: {
          color: colors.text,
          fontSize: fontSizes.lg,
          fontWeight: '700',
        },
      }}
    >
      <Stack.Screen
        name="AdminDashboard"
        component={AdminDashboardScreen}
        options={{ title: 'Admin Dashboard' }}
      />
      <Stack.Screen
        name="AddEditItem"
        component={AddEditItemScreen}
        options={{ title: 'Item' }}
      />
      <Stack.Screen
        name="AdminOrders"
        component={AdminOrdersScreen}
        options={{ title: 'All Orders' }}
      />
      <Stack.Screen
        name="AdminUserOrders"
        component={AdminUserOrdersScreen}
        options={{ title: 'Customer Orders' }}
      />
      <Stack.Screen
        name="TenantManagement"
        component={TenantManagementScreen}
        options={{ title: 'Tenant Admins' }}
      />
      <Stack.Screen
        name="TenantDetail"
        component={TenantDetailScreen}
        options={{ title: 'Tenant Details' }}
      />
    </Stack.Navigator>
  );
}
