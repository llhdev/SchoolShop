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
  AdminAnalysis: undefined;
  AdminUserOrders: { phoneNumber: string; tenantId?: string };
  AdminAccount: undefined;
  TenantManagement: undefined;
  TenantDetail: { tenantId: string };
};

export type RootStackParamList = {
  UserTabs: NavigatorScreenParams<UserTabParamList>;
  AdminStack: NavigatorScreenParams<AdminStackParamList>;
  /** emails: every login account behind this gateway username — the shop
   *  owner plus its staff accounts (migration 045). The password picks one. */
  AdminLogin: { username: string; emails: string[] };
  ProductDetail: { productId: string };
  Checkout: undefined;
  OrderDetail: { orderId: string };
};
