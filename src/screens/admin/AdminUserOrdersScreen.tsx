import { Platform } from 'react-native';
import { useEffect, useState } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { ProductImage } from '../../components/ProductImage';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { VerificationBadge } from '../../components/VerificationBadge';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { formatVariantLabel, getUnitPrice } from '../../utils/variants';
import { getOrderItemsForScope, getOrderItemsForTenant } from '../../services/orders';
import { fetchVerificationsForOrders, subscribeToVerifications } from '../../services/paymentVerifications';
import { getProductCoverImage } from '../../utils/images';
import { PaymentVerification } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, pageWidth, ColorPalette } from '../../constants/theme';

export function AdminUserOrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute();
  const { phoneNumber, tenantId } = route.params as { phoneNumber: string; tenantId?: string };
  const { orders, role, staffSession, effectiveTenantId } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  // Staff see only their shop's line items within these orders — narrowed to
  // their branch when branch-scoped; the super admin browsing a picked shop
  // (tenantId param) is scoped to that shop's items.
  const isSuperAdmin = role === 'super_admin';
  const canSeeMoney = isSuperAdmin || !!staffSession?.capabilities.financial;
  const scopedTenantId = tenantId ?? effectiveTenantId;
  const itemsOf = (order: (typeof orders)[number]) => {
    if (!scopedTenantId) return order.items;
    return tenantId
      ? getOrderItemsForTenant(order, tenantId)
      : getOrderItemsForScope(
          order,
          scopedTenantId,
          staffSession?.branchId,
          staffSession?.branchSelectionEnabled !== false
        );
  };
  const tenantTotal = (order: (typeof orders)[number]) =>
    itemsOf(order).reduce((sum, item) => sum + getUnitPrice(item) * item.quantity, 0);

  const userOrders = orders
    .filter((order) => order.phoneNumber === phoneNumber)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // verify.et payment verification chips (migration 040). RLS scopes the read:
  // tenant admins only receive their own shop's attempts. Money-blind staff
  // never fetch verification rows at all.
  const [verifications, setVerifications] = useState<PaymentVerification[]>([]);
  const orderIdsKey = userOrders.map((o) => o.id).join(',');
  useEffect(() => {
    if (!orderIdsKey || !canSeeMoney) return;
    let cancelled = false;
    const load = () =>
      fetchVerificationsForOrders(orderIdsKey.split(','))
        .then((rows) => {
          if (!cancelled) setVerifications(rows);
        })
        .catch(() => {});
    load();
    const unsubscribe = subscribeToVerifications(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderIdsKey, canSeeMoney]);

  const verificationFor = (orderId: string): PaymentVerification | undefined =>
    verifications.find(
      (v) => v.orderId === orderId && (!scopedTenantId || v.tenantId === scopedTenantId)
    );

  const isWeb = Platform.OS === 'web';

  if (userOrders.length === 0) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen>
          <EmptyState message="No orders found for this user." icon="receipt-outline" />
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.container}>
        <Text style={[styles.title, isPhone && styles.titleCompact]}>Customer Orders</Text>
        <Text style={styles.subtitle}>
          {phoneNumber} · {userOrders.length} order{userOrders.length === 1 ? '' : 's'}
        </Text>

        <FlatList
          data={userOrders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const visibleItems = itemsOf(item);
            const firstItem = visibleItems[0];
            const imageUri = firstItem ? getProductCoverImage(firstItem.product) : null;
            const itemNames = visibleItems
              .map((i) => {
                const label = formatVariantLabel(i);
                return label ? `${i.product.name} (${label})` : i.product.name;
              })
              .join(', ');

            return (
              <TouchableOpacity
                style={styles.card}
                onPress={() => navigation.navigate('OrderDetail', { orderId: item.id })}
              >
                <View style={styles.thumbnail}>
                  <ProductImage
                    uri={imageUri}
                    category={firstItem?.product.category}
                    name={firstItem?.product.name}
                    thumbnail
                    style={styles.thumbnailImage}
                  />
                </View>
                <View style={styles.details}>
                  <View style={styles.header}>
                    {canSeeMoney ? (
                      <Text style={styles.total}>{formatPrice(tenantTotal(item))}</Text>
                    ) : (
                      <View />
                    )}
                    <Text style={styles.date}>
                      {new Date(item.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <Text style={styles.itemNames} numberOfLines={2}>
                    {itemNames}
                  </Text>
                  {scopedTenantId && visibleItems.length < item.items.length && (
                    <Text style={styles.sharedHint}>
                      {visibleItems.length} of {item.items.length} items are from this shop
                    </Text>
                  )}
                  <Text style={styles.paymentMethod}>Bank transfer</Text>
                </View>
                <View style={styles.badges}>
                  <OrderStatusBadge status={item.status} />
                  {canSeeMoney && verificationFor(item.id) && (
                    <VerificationBadge status={verificationFor(item.id)!.status} />
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>
    </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  container: {
    flex: 1,
    maxWidth: pageWidth.data,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  titleCompact: {
    fontSize: fontSizes.xl,
  },
  subtitle: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...(Platform.OS === 'web'
      ? ({
          cursor: 'pointer',
        } as any)
      : {}),
  },
  thumbnail: {
    width: 64,
    height: 64,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    marginRight: spacing.md,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  details: {
    flex: 1,
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  total: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
  },
  date: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  itemNames: {
    fontSize: fontSizes.sm,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  sharedHint: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  paymentMethod: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
  },
  badges: {
    alignItems: 'flex-end',
    gap: spacing.xs,
    marginLeft: spacing.sm,
  },
});
