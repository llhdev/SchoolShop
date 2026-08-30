import { NavigatorScreenParams } from '@react-navigation/native';

export type UserTabParamList = {
  Home: undefined;
  Cart: undefined;
  Orders: undefined;
};

export type AdminStackParamList = {
  AdminDashboard: undefined;
  AdminProducts: undefined;
  AddEditItem: { productId?: string } | undefined;
  AdminOrders: undefined;
  AdminUserOrders: { phoneNumber: string };
  TenantManagement: undefined;
  TenantDetail: { tenantId: string };
};

export type RootStackParamList = {
  UserTabs: NavigatorScreenParams<UserTabParamList>;
  AdminStack: NavigatorScreenParams<AdminStackParamList>;
  AdminLogin: { username: string; email: string };
  ProductDetail: { productId: string };
  Checkout: undefined;
  OrderDetail: { orderId: string };
};
