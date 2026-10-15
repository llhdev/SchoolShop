import { useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { SearchBar } from '../../components/SearchBar';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { getUnitPrice } from '../../utils/variants';
import { getOrderItemsForTenant } from '../../services/orders';
import { Order } from '../../types';
import { AdminStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 1000;

interface ShopperRow {
  phoneNumber: string;
  name: string | null;
  location: string;
  orderCount: number;
  itemCount: number;
  totalSpent: number;
  lastOrderAt: string;
}

/** Best-effort shopper name: a checkout-question answer whose label mentions
 *  "name" (migration 036), else the legacy student_name field. */
function shopperName(order: Order): string | null {
  for (const item of order.items) {
    const hit = item.fieldAnswers?.find(
      (a) => /name/i.test(a.label) && a.value.trim()
    );
    if (hit) return hit.value.trim();
  }
  return order.studentName ?? null;
}

export function AdminAnalysisScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminStackParamList>>();
  const { orders, role, currentUserId } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [query, setQuery] = useState('');

  // Tenant admins are scoped to their own line items (mixed orders included);
  // the super admin sees every shop's items.
  const scopedTenantId = role === 'admin' ? currentUserId : null;

  const shoppers = useMemo<ShopperRow[]>(() => {
    const byPhone = new Map<string, ShopperRow>();
    const sorted = [...orders].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    for (const order of sorted) {
      const items = scopedTenantId
        ? getOrderItemsForTenant(order, scopedTenantId)
        : order.items;
      if (items.length === 0) continue;
      const itemTotal = items.reduce(
        (sum, item) => sum + getUnitPrice(item) * item.quantity,
        0
      );
      // Super admin: order.total already includes every shop's shipping fee.
      const fee = scopedTenantId
        ? order.shippingFees?.[scopedTenantId] ?? 0
        : order.total - itemTotal;
      const units = items.reduce((sum, item) => sum + item.quantity, 0);

      const existing = byPhone.get(order.phoneNumber);
      if (existing) {
        existing.orderCount += 1;
        existing.itemCount += units;
        existing.totalSpent += itemTotal + fee;
        if (!existing.name) existing.name = shopperName(order);
        if (!existing.location && order.location) existing.location = order.location;
      } else {
        // Orders are newest-first, so the first sighting carries the latest
        // name/location and is the last-order date.
        byPhone.set(order.phoneNumber, {
          phoneNumber: order.phoneNumber,
          name: shopperName(order),
          location: order.location,
          orderCount: 1,
          itemCount: units,
          totalSpent: itemTotal + fee,
          lastOrderAt: order.createdAt,
        });
      }
    }
    return [...byPhone.values()];
  }, [orders, scopedTenantId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shoppers;
    return shoppers.filter(
      (s) =>
        s.phoneNumber.toLowerCase().includes(q) ||
        (s.name ?? '').toLowerCase().includes(q)
    );
  }, [shoppers, query]);

  const totalRevenue = shoppers.reduce((sum, s) => sum + s.totalSpent, 0);
  const totalOrders = shoppers.reduce((sum, s) => sum + s.orderCount, 0);

  const isWeb = Platform.OS === 'web';

  function renderRow({ item }: { item: ShopperRow }) {
    const open = () =>
      navigation.navigate('AdminUserOrders', { phoneNumber: item.phoneNumber });

    if (isPhone) {
      return (
        <TouchableOpacity style={styles.card} onPress={open}>
          <View style={styles.cardTop}>
            <View style={styles.cardIdentity}>
              <Text style={styles.cardName} numberOfLines={1}>
                {item.name ?? '—'}
              </Text>
              <Text style={styles.cardPhone}>{item.phoneNumber}</Text>
            </View>
            <Text style={styles.cardTotal}>{formatPrice(item.totalSpent)}</Text>
          </View>
          {!!item.location && (
            <Text style={styles.cardLocation} numberOfLines={1}>
              {item.location}
            </Text>
          )}
          <Text style={styles.cardMeta}>
            {item.orderCount} order(s) · {item.itemCount} item(s) · last{' '}
            {new Date(item.lastOrderAt).toLocaleDateString()}
          </Text>
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity style={styles.row} onPress={open}>
        <View style={styles.cellShopper}>
          <Text style={styles.shopperName} numberOfLines={1}>
            {item.name ?? '—'}
          </Text>
          <Text style={styles.shopperPhone}>{item.phoneNumber}</Text>
        </View>
        <Text style={[styles.cellText, styles.cellLocation]} numberOfLines={1}>
          {item.location || '—'}
        </Text>
        <Text style={[styles.cellText, styles.cellNum]}>{item.orderCount}</Text>
        <Text style={[styles.cellText, styles.cellNum]}>{item.itemCount}</Text>
        <Text style={[styles.cellText, styles.cellNum, styles.cellTotal]}>
          {formatPrice(item.totalSpent)}
        </Text>
        <Text style={[styles.cellText, styles.cellNum]}>
          {new Date(item.lastOrderAt).toLocaleDateString()}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
          <Text style={[styles.title, isPhone && styles.titleCompact]}>
            Shopper Analysis
          </Text>
          <Text style={styles.subtitle}>
            {role === 'admin'
              ? "Customers who ordered from your shop."
              : 'Every shopper on the platform, across all shops.'}
          </Text>

          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{shoppers.length}</Text>
              <Text style={styles.statLabel}>Shoppers</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{totalOrders}</Text>
              <Text style={styles.statLabel}>Orders</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{formatPrice(totalRevenue)}</Text>
              <Text style={styles.statLabel}>Revenue</Text>
            </View>
          </View>

          <SearchBar
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name or phone..."
          />

          {shoppers.length === 0 ? (
            <EmptyState
              message="No shoppers yet — customers appear here once they place an order."
              icon="people-outline"
            />
          ) : (
            <>
              {!isPhone && (
                <View style={[styles.row, styles.headerRow]}>
                  <Text style={[styles.headerText, styles.cellShopper]}>Shopper</Text>
                  <Text style={[styles.headerText, styles.cellLocation]}>Location</Text>
                  <Text style={[styles.headerText, styles.cellNum]}>Orders</Text>
                  <Text style={[styles.headerText, styles.cellNum]}>Items</Text>
                  <Text style={[styles.headerText, styles.cellNum]}>Total spent</Text>
                  <Text style={[styles.headerText, styles.cellNum]}>Last order</Text>
                </View>
              )}
              <FlatList
                data={filtered}
                keyExtractor={(item) => item.phoneNumber}
                renderItem={renderRow}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                  <EmptyState
                    message="No shoppers match your search."
                    icon="search-outline"
                  />
                }
              />
            </>
          )}
        </View>
      </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
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
      marginBottom: spacing.xs,
    },
    titleCompact: {
      fontSize: fontSizes.xl,
    },
    subtitle: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      marginBottom: spacing.md,
    },
    statsRow: {
      flexDirection: 'row',
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    statCard: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
    },
    statValue: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.primary,
    },
    statLabel: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    listContent: {
      paddingBottom: spacing.xxl,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: borderRadius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginTop: spacing.sm,
      gap: spacing.md,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    headerRow: {
      backgroundColor: 'transparent',
      borderWidth: 0,
      paddingVertical: 0,
    },
    headerText: {
      fontSize: fontSizes.xs,
      fontWeight: '700',
      color: colors.textSecondary,
      textTransform: 'uppercase',
    },
    cellShopper: {
      flex: 2,
    },
    shopperName: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
    },
    shopperPhone: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    cellLocation: {
      flex: 2,
    },
    cellNum: {
      flex: 1,
      textAlign: 'right',
    },
    cellText: {
      fontSize: fontSizes.sm,
      color: colors.text,
    },
    cellTotal: {
      fontWeight: '700',
      color: colors.primary,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginTop: spacing.sm,
      gap: spacing.xs,
    },
    cardTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: spacing.sm,
    },
    cardIdentity: {
      flex: 1,
    },
    cardName: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
    },
    cardPhone: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    cardTotal: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.primary,
    },
    cardLocation: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    cardMeta: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
    },
  });
