import { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  ScrollView,
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
import { formatVariantLabel, getUnitPrice } from '../../utils/variants';
import { getOrderItemsForTenant } from '../../services/orders';
import { fetchShoppersByTelegramIds } from '../../services/telegramAuth';
import { Shopper } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 1200;
const NAME_LABEL = /name/i;

/** One row per merchant line item: checkout answers live on the cart line. */
interface AnalysisRow {
  key: string;
  orderId: string;
  createdAt: string;
  location: string;
  phoneNumber: string;
  telegramId?: number;
  productLabel: string;
  studentName: string;
  /** Checkout-question answers, excluding the name-like one. */
  answers: Record<string, string>;
}

function telegramName(shopper: Shopper | undefined): string {
  if (!shopper) return '—';
  const full = [shopper.firstName, shopper.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  return shopper.username ? `@${shopper.username}` : '—';
}

export function AdminAnalysisScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { orders, role, currentUserId } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [query, setQuery] = useState('');
  const [telegramNames, setTelegramNames] = useState<Map<number, Shopper>>(new Map());

  // Tenant admins are scoped to their own line items (mixed orders included);
  // the super admin sees every shop's items.
  const scopedTenantId = role === 'admin' ? currentUserId : null;

  const { rows, questionLabels } = useMemo(() => {
    const rows: AnalysisRow[] = [];
    const questionLabels: string[] = [];
    const sorted = [...orders].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    for (const order of sorted) {
      const items = scopedTenantId
        ? getOrderItemsForTenant(order, scopedTenantId)
        : order.items;
      items.forEach((item, index) => {
        const variant = formatVariantLabel(item);
        const answers: Record<string, string> = {};
        let studentName = '';
        for (const answer of item.fieldAnswers ?? []) {
          if (!answer.value.trim()) continue;
          if (NAME_LABEL.test(answer.label)) {
            if (!studentName) studentName = answer.value.trim();
            continue;
          }
          answers[answer.label] = answer.value.trim();
          if (!questionLabels.includes(answer.label)) questionLabels.push(answer.label);
        }
        if (!studentName && order.studentName) studentName = order.studentName;
        rows.push({
          key: `${order.id}:${index}`,
          orderId: order.id,
          createdAt: order.createdAt,
          location: order.location,
          phoneNumber: order.phoneNumber,
          telegramId: order.telegramId,
          productLabel: `${item.product.name}${variant ? ` (${variant})` : ''} × ${item.quantity}`,
          studentName,
          answers,
        });
      });
    }
    return { rows, questionLabels };
  }, [orders, scopedTenantId]);

  // Resolve Telegram usernames/names for Mini App orders (public-read table).
  const telegramIdsKey = useMemo(
    () =>
      [...new Set(rows.map((r) => r.telegramId).filter((id): id is number => id != null))]
        .sort((a, b) => a - b)
        .join(','),
    [rows]
  );
  useEffect(() => {
    if (!telegramIdsKey) return;
    let cancelled = false;
    fetchShoppersByTelegramIds(telegramIdsKey.split(',').map(Number))
      .then((map) => {
        if (!cancelled) setTelegramNames(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [telegramIdsKey]);

  const summary = useMemo(() => {
    const phones = new Set<string>();
    let orderCount = 0;
    let revenue = 0;
    for (const order of orders) {
      const items = scopedTenantId
        ? getOrderItemsForTenant(order, scopedTenantId)
        : order.items;
      if (items.length === 0) continue;
      orderCount += 1;
      phones.add(order.phoneNumber);
      const itemTotal = items.reduce(
        (sum, item) => sum + getUnitPrice(item) * item.quantity,
        0
      );
      // Super admin: order.total already includes every shop's shipping fee.
      const fee = scopedTenantId
        ? order.shippingFees?.[scopedTenantId] ?? 0
        : order.total - itemTotal;
      revenue += itemTotal + fee;
    }
    return { shoppers: phones.size, orders: orderCount, revenue };
  }, [orders, scopedTenantId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const haystack = [
        r.orderId,
        r.phoneNumber,
        r.location,
        r.productLabel,
        r.studentName,
        telegramName(r.telegramId != null ? telegramNames.get(r.telegramId) : undefined),
        ...Object.values(r.answers),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, query, telegramNames]);

  const isWeb = Platform.OS === 'web';

  function renderCard(row: AnalysisRow) {
    const fields: [string, string][] = [
      ['Order #', row.orderId],
      ['Date & time', new Date(row.createdAt).toLocaleString()],
      ['Location', row.location || '—'],
      ['Phone', row.phoneNumber],
      ['Name', telegramName(row.telegramId != null ? telegramNames.get(row.telegramId) : undefined)],
      ['Student name', row.studentName || '—'],
      ['Product', row.productLabel],
      ...questionLabels.map(
        (label): [string, string] => [label, row.answers[label] ?? '—']
      ),
    ];
    return (
      <TouchableOpacity
        key={row.key}
        style={styles.card}
        onPress={() => navigation.navigate('OrderDetail', { orderId: row.orderId })}
      >
        {fields.map(([label, value]) => (
          <View key={label} style={styles.cardField}>
            <Text style={styles.cardLabel}>{label}</Text>
            <Text style={styles.cardValue}>{value}</Text>
          </View>
        ))}
      </TouchableOpacity>
    );
  }

  function cell(text: string, width: { width: number }, key: string, bold = false) {
    return (
      <Text key={key} style={[styles.cell, width, bold && styles.cellBold]} numberOfLines={2}>
        {text}
      </Text>
    );
  }

  const isEmpty = rows.length === 0;

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen scroll noPadding edges={['left', 'right']}>
        <View style={styles.container}>
          <Text style={[styles.title, isPhone && styles.titleCompact]}>
            Shopper Analysis
          </Text>
          <Text style={styles.subtitle}>
            {role === 'admin'
              ? 'Every item ordered from your shop, one row per item.'
              : 'Every item ordered on the platform, across all shops.'}
          </Text>

          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{summary.shoppers}</Text>
              <Text style={styles.statLabel}>Shoppers</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{summary.orders}</Text>
              <Text style={styles.statLabel}>Orders</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{formatPrice(summary.revenue)}</Text>
              <Text style={styles.statLabel}>Revenue</Text>
            </View>
          </View>

          <SearchBar
            value={query}
            onChangeText={setQuery}
            placeholder="Search orders, shoppers, products..."
          />

          {isEmpty ? (
            <EmptyState
              message="No orders yet — they appear here once customers buy something."
              icon="receipt-outline"
            />
          ) : filtered.length === 0 ? (
            <EmptyState message="No rows match your search." icon="search-outline" />
          ) : isPhone ? (
            <View style={styles.cardList}>{filtered.map(renderCard)}</View>
          ) : (
            <ScrollView horizontal style={styles.tableScroll}>
              <View style={styles.table}>
                <View style={[styles.trow, styles.thead]}>
                  {cell('Order #', styles.wOrder, 'h-order', true)}
                  {cell('Date & time', styles.wDate, 'h-date', true)}
                  {cell('Location', styles.wLocation, 'h-location', true)}
                  {cell('Phone', styles.wPhone, 'h-phone', true)}
                  {cell('Name', styles.wName, 'h-name', true)}
                  {cell('Student name', styles.wName, 'h-student', true)}
                  {cell('Product', styles.wProduct, 'h-product', true)}
                  {questionLabels.map((label) => cell(label, styles.wQuestion, `h-${label}`, true))}
                </View>
                {filtered.map((row) => (
                  <TouchableOpacity
                    key={row.key}
                    style={styles.trow}
                    onPress={() => navigation.navigate('OrderDetail', { orderId: row.orderId })}
                  >
                    {cell(row.orderId, styles.wOrder, `${row.key}-order`)}
                    {cell(new Date(row.createdAt).toLocaleString(), styles.wDate, `${row.key}-date`)}
                    {cell(row.location || '—', styles.wLocation, `${row.key}-location`)}
                    {cell(row.phoneNumber, styles.wPhone, `${row.key}-phone`)}
                    {cell(
                      telegramName(row.telegramId != null ? telegramNames.get(row.telegramId) : undefined),
                      styles.wName,
                      `${row.key}-name`
                    )}
                    {cell(row.studentName || '—', styles.wName, `${row.key}-student`)}
                    {cell(row.productLabel, styles.wProduct, `${row.key}-product`)}
                    {questionLabels.map((label) =>
                      cell(row.answers[label] ?? '—', styles.wQuestion, `${row.key}-${label}`)
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
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
      paddingBottom: spacing.xxl,
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
    tableScroll: {
      marginTop: spacing.md,
    },
    table: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    trow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: 1,
      borderColor: colors.border,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    thead: {
      borderTopWidth: 0,
      backgroundColor: colors.background,
    },
    cell: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      fontSize: fontSizes.sm,
      color: colors.text,
    },
    cellBold: {
      fontWeight: '700',
      color: colors.textSecondary,
    },
    wOrder: { width: 100 },
    wDate: { width: 170 },
    wLocation: { width: 170 },
    wPhone: { width: 120 },
    wName: { width: 150 },
    wProduct: { width: 220 },
    wQuestion: { width: 150 },
    cardList: {
      marginTop: spacing.sm,
      gap: spacing.sm,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: spacing.xs,
    },
    cardField: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    cardLabel: {
      width: 110,
      fontSize: fontSizes.xs,
      fontWeight: '700',
      color: colors.textSecondary,
      textTransform: 'uppercase',
    },
    cardValue: {
      flex: 1,
      fontSize: fontSizes.sm,
      color: colors.text,
    },
  });
