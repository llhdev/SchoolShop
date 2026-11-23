import { NavigatorScreenParams } from '@react-navigation/native';

import { CartItem } from './index';

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
  AdminReports: undefined;
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
  /** buyNowItem: Amazon-style Buy Now (a direct checkout of this one item;
   *  the cart is left untouched and NOT cleared after the order). Absent =
   *  normal cart checkout. */
  Checkout: { buyNowItem?: CartItem } | undefined;
  OrderDetail: { orderId: string };
};
