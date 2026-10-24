import { NavigatorScreenParams } from '@react-navigation/native';
import { CartItem } from './index';

export type UserTabParamList = {
  Home: undefined;
  Orders: undefined;
};

export type AdminStackParamList = {
  AdminDashboard: undefined;
  AdminProducts: undefined;
  AddEditItem: { productId?: string } | undefined;
  AdminOrders: undefined;
  AdminAnalysis: undefined;
  AdminUserOrders: { phoneNumber: string; tenantId?: string };
  AdminAccount: undefined;
  TenantManagement: undefined;
  TenantDetail: { tenantId: string };
};

export type RootStackParamList = {
  UserTabs: NavigatorScreenParams<UserTabParamList>;
  AdminStack: NavigatorScreenParams<AdminStackParamList>;
  AdminLogin: { username: string; email: string };
  ProductDetail: { productId: string };
  Checkout: { items: CartItem[] };
  OrderDetail: { orderId: string };
};
