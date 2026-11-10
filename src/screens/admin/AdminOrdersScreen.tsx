import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { getUnitPrice } from '../../utils/variants';
import { getOrderItemsForScope, getOrderItemsForTenant } from '../../services/orders';
import { fetchTenants, Tenant } from '../../services/tenants';
import { AdminStackParamList } from '../../types/navigation';
import { Order, OrderStatus } from '../../types';
import { ALL_ORDER_STATUSES, ORDER_STATUSES, ORDER_STATUS_LABELS } from '../../constants/orderStatus';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 1000;

type StatusFilter = OrderStatus | 'all';

interface UserOrderGroup {
  phoneNumber: string;
  orders: Order[];
  count: number;
  total: number;
  latestDate: Date;
  latestOrderId: string;
}

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  ...ALL_ORDER_STATUSES.map((status) => ({ key: status, label: ORDER_STATUS_LABELS[status] })),
];

export function AdminOrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminStackParamList>>();
  const { orders, role, staffSession, effectiveTenantId } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  // Accent color per lifecycle status on the summary cards below.
  const STAT_STYLES = {
    pending: styles.pendingStat,
    received: styles.receivedStat,
    paid: styles.paidStat,
    on_the_way: styles.onTheWayStat,
    completed: styles.completedStat,
  } as const;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Super admin: orders are separated per tenant — pick a shop first, then
  // browse that shop's orders (grouped by customer phone as usual).
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantsFailed, setTenantsFailed] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);

  const isSuperAdmin = role === 'super_admin';
  const isTenantAdmin = role === 'admin' && !!effectiveTenantId;
  // Money is visible to the super admin and financial staff only (045).
  const canSeeMoney = isSuperAdmin || !!staffSession?.capabilities.financial;

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    fetchTenants()
      .then((list) => {
        if (!cancelled) setTenants(list);
      })
      .catch(() => {
        if (!cancelled) setTenantsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  const selectedTenant = isSuperAdmin
    ? tenants.find((t) => t.id === selectedTenantId) ?? null
    : null;

  // Staff only see orders containing their shop's products (already scoped
  // server-side via tenant_ids); the super admin (inside a picked shop) is
  // scoped the same way client-side. Branch-scoped staff are further narrowed
  // to their branch's line items. Totals/counts use only those line items
  // when an order mixes shops.
  const activeTenantId = isSuperAdmin
    ? selectedTenantId
    : isTenantAdmin
      ? effectiveTenantId
      : null;
  const itemsOf = (order: Order) => {
    if (!activeTenantId) return order.items;
    return isSuperAdmin
      ? getOrderItemsForTenant(order, activeTenantId)
      : getOrderItemsForScope(
          order,
          activeTenantId,
          staffSession?.branchId,
          staffSession?.branchSelectionEnabled !== false
        );
  };
  const visibleOrders = activeTenantId
    ? orders.filter((o) => itemsOf(o).length > 0)
    : orders;

  const tenantOrderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!isSuperAdmin) return counts;
    for (const tenant of tenants) {
      counts.set(
        tenant.id,
        orders.filter((o) => getOrderItemsForTenant(o, tenant.id).length > 0).length
      );
    }
    return counts;
  }, [isSuperAdmin, tenants, orders]);

  // Check-and-balance summary over the full order list (not the filter), one
  // count per lifecycle status (cancelled stays a filter chip only).
  const counts = useMemo(() => {
    const result = {} as Record<(typeof ORDER_STATUSES)[number], number>;
    for (const status of ORDER_STATUSES) {
      result[status] = visibleOrders.filter((o) => o.status === status).length;
    }
    return result;
  }, [visibleOrders]);

  const filteredOrders =
    statusFilter === 'all'
      ? visibleOrders
      : visibleOrders.filter((order) => order.status === statusFilter);

  const grouped = filteredOrders.reduce<Record<string, UserOrderGroup>>((acc, order) => {
    const phoneNumber = order.phoneNumber?.trim() || 'No phone number';
    if (!acc[phoneNumber]) {
      acc[phoneNumber] = {
        phoneNumber,
        orders: [],
        count: 0,
        total: 0,
        latestDate: new Date(order.createdAt),
        latestOrderId: order.id,
      };
    }
    acc[phoneNumber].orders.push(order);
    acc[phoneNumber].count += 1;
    acc[phoneNumber].total += itemsOf(order).reduce(
      (sum, item) => sum + getUnitPrice(item) * item.quantity,
      0
    );
    const orderDate = new Date(order.createdAt);
    if (orderDate > acc[phoneNumber].latestDate) {
      acc[phoneNumber].latestDate = orderDate;
      acc[phoneNumber].latestOrderId = order.id;
    }
    return acc;
  }, {});

  const userGroups = Object.values(grouped).sort(
    (a, b) => b.latestDate.getTime() - a.latestDate.getTime()
  );

  const isWeb = Platform.OS === 'web';

  // Super admin entry point: the list of shops, each leading to that shop's
  // orders. Tenant admins land directly on their own shop's order list.
  if (isSuperAdmin && !selectedTenantId) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen noPadding edges={['top', 'left', 'right']}>
          <View style={styles.container}>
            <Text style={[styles.title, isPhone && styles.titleCompact]}>Orders by Shop</Text>
            {tenantsFailed ? (
              <EmptyState
                message="Failed to load shops. Please try again."
                icon="storefront-outline"
              />
            ) : tenants.length === 0 ? (
              <EmptyState message="No tenants yet." icon="storefront-outline" />
            ) : (
              tenants.map((tenant) => {
                const count = tenantOrderCounts.get(tenant.id) ?? 0;
                return (
                  <TouchableOpacity
                    key={tenant.id}
                    style={styles.tenantCard}
                    onPress={() => setSelectedTenantId(tenant.id)}
                  >
                    {tenant.shopLogoUrl ? (
                      <Image source={{ uri: tenant.shopLogoUrl }} style={styles.tenantLogo} />
                    ) : (
                      <View style={[styles.tenantLogo, styles.tenantLogoFallback]}>
                        <Ionicons name="storefront-outline" size={22} color={colors.primary} />
                      </View>
                    )}
                    <View style={styles.tenantCardText}>
                      <Text style={styles.tenantName} numberOfLines={1}>
                        {tenant.shopName ?? 'Unnamed shop'}
                      </Text>
                      <Text style={styles.tenantDetail}>
                        {count} order{count === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </Screen>
      </>
    );
  }

  // Only bail out to a bare empty state when there are no orders at all —
  // when a status filter merely matches nothing, the main screen must still
  // render (with an inline empty state) so the stats and filter chips stay
  // visible and the filter can be changed back.
  if (visibleOrders.length === 0) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen>
          <EmptyState message="No orders yet." icon="receipt-outline" />
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
        {isSuperAdmin && (
          <TouchableOpacity style={styles.backRow} onPress={() => setSelectedTenantId(null)}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
            <Text style={styles.backText}>All shops</Text>
          </TouchableOpacity>
        )}
        <Text style={[styles.title, isPhone && styles.titleCompact]}>
          {isSuperAdmin ? (selectedTenant?.shopName ?? 'Orders') : 'Orders by Customer'}
        </Text>

        <View style={styles.statsRow}>
          {(Object.keys(STAT_STYLES) as (keyof typeof STAT_STYLES)[]).map((status) => (
            <View key={status} style={[styles.statCard, STAT_STYLES[status]]}>
              <Text style={styles.statValue}>{counts[status]}</Text>
              <Text style={styles.statLabel} numberOfLines={1}>
                {ORDER_STATUS_LABELS[status]}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.filterRow}>
          {FILTERS.map((filter) => (
            <TouchableOpacity
              key={filter.key}
              style={[
                styles.filterChip,
                statusFilter === filter.key && styles.filterChipActive,
              ]}
              onPress={() => setStatusFilter(filter.key)}
            >
              <Text
                style={[
                  styles.filterChipText,
                  statusFilter === filter.key && styles.filterChipTextActive,
                ]}
              >
                {filter.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {userGroups.length === 0 ? (
          <EmptyState
            message={`No ${FILTERS.find((f) => f.key === statusFilter)?.label.toLowerCase() ?? ''} orders.`}
            icon="receipt-outline"
          />
        ) : (
        <FlatList
          data={userGroups}
          keyExtractor={(item) => item.phoneNumber}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() =>
                navigation.navigate('AdminUserOrders', {
                  phoneNumber: item.phoneNumber,
                  ...(activeTenantId ? { tenantId: activeTenantId } : {}),
                })
              }
            >
              <View style={styles.cardHeader}>
                <Text style={styles.phoneNumber} numberOfLines={1}>
                  {item.phoneNumber}
                </Text>
                <Text style={styles.orderNumber} numberOfLines={1}>
                  #{item.latestOrderId}
                </Text>
              </View>

              <View style={styles.cardFooter}>
                {canSeeMoney ? (
                  <Text style={styles.total}>{formatPrice(item.total)}</Text>
                ) : (
                  <View />
                )}
                <Text style={styles.date}>
                  Order date: {item.latestDate.toLocaleDateString()}
                </Text>
              </View>
              {activeTenantId &&
                canSeeMoney &&
                item.orders.some((o) => itemsOf(o).length < o.items.length) && (
                  <Text style={styles.sharedHint}>
                    Totals reflect only this shop's items in these orders.
                  </Text>
                )}
            </TouchableOpacity>
          )}
        />
        )}
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
  title: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  titleCompact: {
    fontSize: fontSizes.xl,
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginBottom: spacing.sm,
  },
  backText: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.primary,
  },
  tenantCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...(Platform.OS === 'web'
      ? ({
          cursor: 'pointer',
        } as any)
      : {}),
  },
  tenantLogo: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  tenantLogoFallback: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tenantCardText: {
    flex: 1,
  },
  tenantName: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  tenantDetail: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  pendingStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
  },
  receivedStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  paidStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.success,
  },
  onTheWayStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  completedStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.success,
  },
  statValue: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  statLabel: {
    fontSize: fontSizes.xs,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterChipText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.text,
  },
  filterChipTextActive: {
    color: colors.surface,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...(Platform.OS === 'web'
      ? ({
          cursor: 'pointer',
          transition: 'box-shadow 0.15s ease',
        } as any)
      : {}),
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  phoneNumber: {
    flex: 1,
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.text,
    marginRight: spacing.md,
  },
  orderNumber: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  sharedHint: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },
});
