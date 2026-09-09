import { useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { AdminStackParamList } from '../../types/navigation';
import { Order, OrderStatus } from '../../types';
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
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
];

export function AdminOrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminStackParamList>>();
  const { orders } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Check-and-balance summary over the full order list (not the filter).
  const counts = useMemo(
    () => ({
      pending: orders.filter((o) => o.status === 'pending').length,
      completed: orders.filter((o) => o.status === 'completed').length,
      failed: orders.filter((o) => o.status === 'failed').length,
      // Legacy statuses from before completed/failed existed.
      other: orders.filter(
        (o) => o.status !== 'pending' && o.status !== 'completed' && o.status !== 'failed'
      ).length,
    }),
    [orders]
  );

  const filteredOrders =
    statusFilter === 'all'
      ? orders
      : orders.filter((order) => order.status === statusFilter);

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
    acc[phoneNumber].total += order.total;
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

  if (userGroups.length === 0) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen>
          <EmptyState
            message={
              orders.length === 0
                ? 'No orders yet.'
                : `No ${statusFilter === 'all' ? '' : statusFilter} orders.`
            }
            icon="receipt-outline"
          />
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
        <Text style={[styles.title, isPhone && styles.titleCompact]}>Orders by Customer</Text>

        <View style={styles.statsRow}>
          <View style={[styles.statCard, styles.pendingStat]}>
            <Text style={styles.statValue}>{counts.pending}</Text>
            <Text style={styles.statLabel}>Pending</Text>
          </View>
          <View style={[styles.statCard, styles.completedStat]}>
            <Text style={styles.statValue}>{counts.completed}</Text>
            <Text style={styles.statLabel}>Completed</Text>
          </View>
          <View style={[styles.statCard, styles.failedStat]}>
            <Text style={styles.statValue}>{counts.failed}</Text>
            <Text style={styles.statLabel}>Failed</Text>
          </View>
          {counts.other > 0 && (
            <View style={[styles.statCard, styles.otherStat]}>
              <Text style={styles.statValue}>{counts.other}</Text>
              <Text style={styles.statLabel}>Other</Text>
            </View>
          )}
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

        <FlatList
          data={userGroups}
          keyExtractor={(item) => item.phoneNumber}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() =>
                navigation.navigate('AdminUserOrders', { phoneNumber: item.phoneNumber })
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
                <Text style={styles.total}>{formatPrice(item.total)}</Text>
                <Text style={styles.date}>
                  Order date: {item.latestDate.toLocaleDateString()}
                </Text>
              </View>
            </TouchableOpacity>
          )}
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
  title: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  titleCompact: {
    fontSize: fontSizes.xl,
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
  completedStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.success,
  },
  failedStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
  },
  otherStat: {
    borderLeftWidth: 3,
    borderLeftColor: colors.textSecondary,
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
});
