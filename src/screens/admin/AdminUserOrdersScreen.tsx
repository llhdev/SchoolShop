import { Platform } from 'react-native';
import { useEffect, useState } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { ProductImage } from '../../components/ProductImage';
import { VerificationBadge } from '../../components/VerificationBadge';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { formatVariantLabel, getUnitPrice } from '../../utils/variants';
import { getOrderItemsForTenant } from '../../services/orders';
import { fetchVerificationsForOrders, subscribeToVerifications } from '../../services/paymentVerifications';
import { getProductCoverImage } from '../../utils/images';
import { ORDER_STATUS_LABELS } from '../../constants/orderStatus';
import { PaymentVerification } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 1000;

export function AdminUserOrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute();
  const { phoneNumber, tenantId } = route.params as { phoneNumber: string; tenantId?: string };
  const { orders, role, currentUserId } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  // Tenant admins see only their shop's line items within these orders; the
  // super admin browsing a picked shop (tenantId param) is scoped the same way.
  const isTenantAdmin = role === 'admin' && !!currentUserId;
  const scopedTenantId = tenantId ?? (isTenantAdmin ? currentUserId : null);
  const itemsOf = (order: (typeof orders)[number]) =>
    scopedTenantId ? getOrderItemsForTenant(order, scopedTenantId) : order.items;
  const tenantTotal = (order: (typeof orders)[number]) =>
    itemsOf(order).reduce((sum, item) => sum + getUnitPrice(item) * item.quantity, 0);

  const userOrders = orders
    .filter((order) => order.phoneNumber === phoneNumber)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // verify.et payment verification chips (migration 040). RLS scopes the read:
  // tenant admins only receive their own shop's attempts.
  const [verifications, setVerifications] = useState<PaymentVerification[]>([]);
  const orderIdsKey = userOrders.map((o) => o.id).join(',');
  useEffect(() => {
    if (!orderIdsKey) return;
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
  }, [orderIdsKey]);

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
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
        <Text style={[styles.phoneNumber, isPhone && styles.phoneNumberCompact]}>
          {phoneNumber}
        </Text>
        <Text style={styles.subtitle}>{userOrders.length} order(s)</Text>

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
                    <Text style={styles.total}>{formatPrice(tenantTotal(item))}</Text>
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
                  <View
                    style={[
                      styles.badge,
                      item.status === 'paid' && styles.paidBadge,
                      item.status === 'pending' && styles.pendingBadge,
                      item.status === 'on_the_way' && styles.onTheWayBadge,
                      item.status === 'completed' && styles.completedBadge,
                    ]}
                  >
                    <Text style={styles.badgeText}>{ORDER_STATUS_LABELS[item.status]}</Text>
                  </View>
                  {verificationFor(item.id) && (
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
    maxWidth: MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  phoneNumber: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  phoneNumberCompact: {
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
    color: colors.primary,
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
    textTransform: 'capitalize',
  },
  badges: {
    alignItems: 'flex-end',
    gap: spacing.xs,
    marginLeft: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.border,
  },
  pendingBadge: {
    backgroundColor: colors.warning,
  },
  paidBadge: {
    backgroundColor: colors.success,
  },
  onTheWayBadge: {
    backgroundColor: colors.primary,
  },
  completedBadge: {
    backgroundColor: colors.success,
  },
  badgeText: {
    fontSize: fontSizes.xs,
    fontWeight: '600',
    color: colors.surface,
  },
});
