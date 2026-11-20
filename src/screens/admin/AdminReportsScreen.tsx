import { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { StatCard } from '../../components/StatCard';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import {
  buildReportLines,
  countByStatus,
  filterLines,
  groupByLocation,
  monthlyRepeatRates,
  ordersByHour,
  ordersByWeekday,
  percentChange,
  periodRange,
  previousPeriodRange,
  rankProducts,
  repeatRate,
  sumLines,
  trendBuckets,
  PeriodKey,
  PERIODS,
  PREVIOUS_PERIOD_LABELS,
  ProductRank,
} from '../../utils/reports';
import { ALL_ORDER_STATUSES } from '../../constants/orderStatus';
import { AdminStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, pageWidth, ColorPalette } from '../../constants/theme';

type Navigation = NativeStackNavigationProp<AdminStackParamList>;

type TrendMetric = 'revenue' | 'orders';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOT_SELLER_COUNT = 10;
const LOCATION_COUNT = 10;

/** Signed % delta under a snapshot stat; null hides it (no previous base). */
function DeltaText({ value, suffix, colors }: { value: number | null; suffix: string; colors: ColorPalette }) {
  if (value === null) return null;
  const positive = value >= 0;
  return (
    <Text style={{ fontSize: fontSizes.xs, color: positive ? colors.success : colors.danger }}>
      {positive ? '+' : ''}
      {value}% {suffix}
    </Text>
  );
}

/** Plain-view bar chart: heights normalized to the max value, quiet buckets
 *  still occupy their slot. Shared by the trend, location, and peak charts. */
function BarChart({
  data,
  formatValue,
  colors,
  styles,
  labelEvery = 1,
}: {
  data: { label: string; value: number }[];
  formatValue: (value: number) => string;
  colors: ColorPalette;
  styles: ReturnType<typeof makeStyles>;
  labelEvery?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <View style={styles.chart}>
      {data.map((d, i) => (
        <View key={`${d.label}-${i}`} style={styles.chartColumn}>
          <Text style={styles.chartValue} numberOfLines={1}>
            {d.value > 0 ? formatValue(d.value) : ''}
          </Text>
          <View
            style={[
              styles.chartBar,
              { height: Math.max(2, Math.round((d.value / max) * 120)) },
              d.value === 0 && { backgroundColor: colors.border },
            ]}
          />
          <Text style={styles.chartLabel} numberOfLines={1}>
            {i % labelEvery === 0 ? d.label : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function AdminReportsScreen() {
  const navigation = useNavigation<Navigation>();
  const { orders, products, role, staffSession, effectiveTenantId } = useApp();
  const { isDesktop, isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('orders');

  // Same scoping and money gating as the analysis screen: shop accounts see
  // their own (branch-narrowed) items; revenue only for super admin and
  // financial staff.
  const canSeeMoney = role === 'super_admin' || !!staffSession?.capabilities.financial;

  const lines = useMemo(
    () =>
      buildReportLines(
        orders,
        effectiveTenantId,
        staffSession?.branchId ?? null,
        staffSession?.branchSelectionEnabled !== false
      ),
    [orders, effectiveTenantId, staffSession]
  );

  const periodLines = useMemo(() => filterLines(lines, periodRange(period)), [lines, period]);
  const previousLines = useMemo(
    () => filterLines(lines, previousPeriodRange(period)),
    [lines, period]
  );

  const summary = useMemo(() => sumLines(periodLines), [periodLines]);
  const previousSummary = useMemo(() => sumLines(previousLines), [previousLines]);
  const previousLabel = PREVIOUS_PERIOD_LABELS[period];

  const trend = useMemo(() => trendBuckets(lines, period), [lines, period]);

  const ranked = useMemo(() => rankProducts(periodLines), [periodLines]);

  const hotWeek = useMemo(
    () => rankProducts(filterLines(lines, periodRange('week'))).slice(0, HOT_SELLER_COUNT),
    [lines]
  );
  const hotMonth = useMemo(
    () => rankProducts(filterLines(lines, periodRange('month'))).slice(0, HOT_SELLER_COUNT),
    [lines]
  );

  // Dead stock reads the live catalog (scoped to the shop), not the sales
  // lines — a product that never sold leaves no trace in orders.
  const scopedProducts = useMemo(
    () =>
      role === 'super_admin'
        ? products
        : products.filter((p) => p.ownerId === effectiveTenantId),
    [products, role, effectiveTenantId]
  );
  const soldUnitsByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of periodLines) {
      map.set(line.productId, (map.get(line.productId) ?? 0) + line.quantity);
    }
    return map;
  }, [periodLines]);
  const deadProducts = useMemo(
    () => scopedProducts.filter((p) => !soldUnitsByProduct.has(p.id)),
    [scopedProducts, soldUnitsByProduct]
  );
  const slowProducts = useMemo(
    () =>
      scopedProducts
        .filter((p) => {
          const units = soldUnitsByProduct.get(p.id) ?? 0;
          return units > 0 && units <= 2;
        })
        .sort((a, b) => (soldUnitsByProduct.get(a.id) ?? 0) - (soldUnitsByProduct.get(b.id) ?? 0))
        .slice(0, 5),
    [scopedProducts, soldUnitsByProduct]
  );

  // Status counts reflect the CURRENT state of every in-scope item, so they
  // ignore the period filter (pending doubling as the to-do list).
  const statusCounts = useMemo(() => countByStatus(lines), [lines]);

  const repeat = useMemo(() => repeatRate(periodLines), [periodLines]);
  const repeatTrend = useMemo(() => monthlyRepeatRates(lines), [lines]);

  const locations = useMemo(
    () => groupByLocation(periodLines).slice(0, LOCATION_COUNT),
    [periodLines]
  );

  const weekdayCounts = useMemo(() => ordersByWeekday(lines), [lines]);
  const hourCounts = useMemo(() => ordersByHour(lines), [lines]);

  const isWeb = Platform.OS === 'web';
  const isEmpty = lines.length === 0;

  function renderHotList(title: string, items: ProductRank[]) {
    return (
      <View style={[styles.halfCard, isDesktop && styles.halfCardDesktop]}>
        <Text style={styles.cardTitle}>{title}</Text>
        {items.length === 0 ? (
          <Text style={styles.mutedText}>No sales in this period.</Text>
        ) : (
          items.map((item, index) => (
            <View key={item.productId} style={styles.rankRow}>
              <Text style={styles.rankNumber}>{index + 1}</Text>
              <Text style={styles.rankLabel} numberOfLines={1}>
                {item.label}
              </Text>
              <Text style={styles.rankValue}>
                {item.units} sold{canSeeMoney ? ` · ${formatPrice(item.revenue)}` : ''}
              </Text>
            </View>
          ))
        )}
      </View>
    );
  }

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen scroll noPadding edges={['left', 'right', 'bottom']}>
        <View style={styles.container}>
          <Text style={[styles.title, isPhone && styles.titleCompact]}>Reports</Text>
          <Text style={styles.subtitle}>
            {role === 'super_admin'
              ? 'Sales analytics across every shop.'
              : "Sales analytics for your shop's orders."}
          </Text>

          <View style={styles.filterRow}>
            {PERIODS.map((p) => (
              <TouchableOpacity
                key={p.key}
                style={[styles.chip, period === p.key && styles.chipActive]}
                onPress={() => setPeriod(p.key)}
              >
                <Text style={[styles.chipText, period === p.key && styles.chipTextActive]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {isEmpty ? (
            <EmptyState
              message="No orders yet — reports appear once customers buy something."
              icon="bar-chart-outline"
            />
          ) : (
            <>
              {/* 1. Sales snapshot */}
              <View style={styles.statsRow}>
                <View style={styles.statWrap}>
                  <StatCard value={summary.units} label="Units sold" />
                  <DeltaText
                    value={
                      previousLabel
                        ? percentChange(summary.units, previousSummary.units)
                        : null
                    }
                    suffix={previousLabel ?? ''}
                    colors={colors}
                  />
                </View>
                <View style={styles.statWrap}>
                  <StatCard value={summary.orders} label="Orders" />
                  <DeltaText
                    value={
                      previousLabel
                        ? percentChange(summary.orders, previousSummary.orders)
                        : null
                    }
                    suffix={previousLabel ?? ''}
                    colors={colors}
                  />
                </View>
                <View style={styles.statWrap}>
                  <StatCard value={summary.customers} label="Customers" />
                  <DeltaText
                    value={
                      previousLabel
                        ? percentChange(summary.customers, previousSummary.customers)
                        : null
                    }
                    suffix={previousLabel ?? ''}
                    colors={colors}
                  />
                </View>
                {canSeeMoney && (
                  <View style={styles.statWrap}>
                    <StatCard value={formatPrice(summary.revenue)} label="Revenue" />
                    <DeltaText
                      value={
                        previousLabel
                          ? percentChange(summary.revenue, previousSummary.revenue)
                          : null
                      }
                      suffix={previousLabel ?? ''}
                      colors={colors}
                    />
                  </View>
                )}
              </View>

              {/* 2. Sales trend */}
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>Sales trend</Text>
                  <View style={styles.filterRow}>
                    {canSeeMoney && (
                      <TouchableOpacity
                        style={[styles.chip, trendMetric === 'revenue' && styles.chipActive]}
                        onPress={() => setTrendMetric('revenue')}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            trendMetric === 'revenue' && styles.chipTextActive,
                          ]}
                        >
                          Revenue
                        </Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.chip, trendMetric === 'orders' && styles.chipActive]}
                      onPress={() => setTrendMetric('orders')}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          trendMetric === 'orders' && styles.chipTextActive,
                        ]}
                      >
                        Orders
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
                {trend.length === 0 ? (
                  <Text style={styles.mutedText}>No sales yet.</Text>
                ) : (
                  <BarChart
                    data={trend.map((b) => ({
                      label: b.label,
                      value: trendMetric === 'revenue' && canSeeMoney ? b.revenue : b.orders,
                    }))}
                    formatValue={(v) =>
                      trendMetric === 'revenue' && canSeeMoney ? formatPrice(v) : String(v)
                    }
                    colors={colors}
                    styles={styles}
                  />
                )}
              </View>

              {/* 3. Hot sellers */}
              <Text style={styles.sectionTitle}>Hot sellers</Text>
              <View style={[styles.row, isDesktop && styles.rowDesktop]}>
                {renderHotList('Top 10 this week', hotWeek)}
                {renderHotList('Top 10 this month', hotMonth)}
              </View>

              {/* 4. Units per product */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Units sold per product</Text>
                {ranked.length === 0 ? (
                  <Text style={styles.mutedText}>No sales in this period.</Text>
                ) : (
                  ranked.map((item, index) => (
                    <View key={item.productId} style={styles.rankRow}>
                      <Text style={styles.rankNumber}>{index + 1}</Text>
                      <Text style={styles.rankLabel} numberOfLines={1}>
                        {item.label}
                      </Text>
                      <Text style={styles.rankValue}>
                        {item.units} sold{canSeeMoney ? ` · ${formatPrice(item.revenue)}` : ''}
                      </Text>
                    </View>
                  ))
                )}
              </View>

              {/* 5. Slow movers & dead stock */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Slow movers &amp; dead stock</Text>
                <Text style={styles.cardSubtitle}>
                  Catalog items with no sales in this period.
                </Text>
                {deadProducts.length === 0 ? (
                  <Text style={styles.mutedText}>Every listed item sold at least once.</Text>
                ) : (
                  <>
                    {deadProducts.slice(0, 10).map((p) => (
                      <View key={p.id} style={styles.rankRow}>
                        <Text style={styles.rankLabel} numberOfLines={1}>
                          {p.name}
                        </Text>
                        <Text style={styles.rankValueMuted}>0 sold</Text>
                      </View>
                    ))}
                    {deadProducts.length > 10 && (
                      <Text style={styles.mutedText}>
                        …and {deadProducts.length - 10} more with no sales.
                      </Text>
                    )}
                  </>
                )}
                {slowProducts.length > 0 && (
                  <>
                    <Text style={[styles.cardSubtitle, styles.cardSubtitleSpaced]}>
                      Barely selling (1–2 units).
                    </Text>
                    {slowProducts.map((p) => (
                      <View key={p.id} style={styles.rankRow}>
                        <Text style={styles.rankLabel} numberOfLines={1}>
                          {p.name}
                        </Text>
                        <Text style={styles.rankValueMuted}>
                          {soldUnitsByProduct.get(p.id)} sold
                        </Text>
                      </View>
                    ))}
                  </>
                )}
              </View>

              {/* 6. Orders by status */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Orders by status</Text>
                <Text style={styles.cardSubtitle}>
                  Current state of every item — the pending count is your to-do list.
                </Text>
                <View style={styles.statusGrid}>
                  {ALL_ORDER_STATUSES.map((status) => {
                    const row = (
                      <>
                        <OrderStatusBadge status={status} small />
                        <Text style={styles.statusCount}>{statusCounts[status]}</Text>
                      </>
                    );
                    return status === 'pending' ? (
                      <TouchableOpacity
                        key={status}
                        style={styles.statusRow}
                        onPress={() => navigation.navigate('AdminOrders')}
                      >
                        {row}
                      </TouchableOpacity>
                    ) : (
                      <View key={status} style={styles.statusRow}>
                        {row}
                      </View>
                    );
                  })}
                </View>
              </View>

              {/* 7. Customers */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Customers</Text>
                <View style={styles.statsRow}>
                  <StatCard value={summary.customers} label="Unique customers" />
                  <StatCard
                    value={`${repeat.rate}%`}
                    label={`Repeat (${repeat.repeatCustomers} of ${repeat.totalCustomers})`}
                  />
                </View>
                <Text style={[styles.cardSubtitle, styles.cardSubtitleSpaced]}>
                  Repeat rate by month — share of the month's customers with 2+ orders by
                  month-end.
                </Text>
                <View style={styles.repeatRow}>
                  {repeatTrend.map((month, i) => (
                    <View key={`${month.label}-${i}`} style={styles.repeatCell}>
                      <Text style={styles.repeatValue}>
                        {month.rate === null ? '—' : `${month.rate}%`}
                      </Text>
                      <Text style={styles.repeatLabel}>{month.label}</Text>
                    </View>
                  ))}
                </View>
              </View>

              {/* 8. Where buyers are */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Where buyers are</Text>
                {locations.length === 0 ? (
                  <Text style={styles.mutedText}>No orders in this period.</Text>
                ) : (
                  <BarChart
                    data={locations.map((l) => ({ label: l.label, value: l.orders }))}
                    formatValue={(v) => String(v)}
                    colors={colors}
                    styles={styles}
                  />
                )}
              </View>

              {/* 9. Peak days & hours */}
              <Text style={styles.sectionTitle}>Peak times (all time)</Text>
              <View style={[styles.row, isDesktop && styles.rowDesktop]}>
                <View style={[styles.halfCard, isDesktop && styles.halfCardDesktop]}>
                  <Text style={styles.cardTitle}>By weekday</Text>
                  <BarChart
                    data={weekdayCounts.map((count, i) => ({
                      label: WEEKDAY_LABELS[i],
                      value: count,
                    }))}
                    formatValue={(v) => String(v)}
                    colors={colors}
                    styles={styles}
                  />
                </View>
                <View style={[styles.halfCard, isDesktop && styles.halfCardDesktop]}>
                  <Text style={styles.cardTitle}>By hour</Text>
                  <BarChart
                    data={hourCounts.map((count, i) => ({ label: `${i}`, value: count }))}
                    formatValue={(v) => String(v)}
                    colors={colors}
                    styles={styles}
                    labelEvery={3}
                  />
                </View>
              </View>
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
      maxWidth: pageWidth.data,
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
    filterRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: borderRadius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    chipActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    chipText: {
      fontSize: fontSizes.sm,
      color: colors.text,
    },
    chipTextActive: {
      color: colors.surface,
      fontWeight: '600',
    },
    statsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    statWrap: {
      flex: 1,
      minWidth: 140,
      alignItems: 'center',
      gap: spacing.xs,
    },
    sectionTitle: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
      marginTop: spacing.sm,
      marginBottom: spacing.sm,
    },
    row: {
      gap: spacing.md,
    },
    rowDesktop: {
      flexDirection: 'row',
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    halfCard: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    halfCardDesktop: {
      flex: 1,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    cardTitle: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.sm,
    },
    cardSubtitle: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
      marginBottom: spacing.sm,
    },
    cardSubtitleSpaced: {
      marginTop: spacing.md,
    },
    mutedText: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    chart: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 2,
      marginTop: spacing.sm,
    },
    chartColumn: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'flex-end',
      minWidth: 0,
    },
    chartValue: {
      fontSize: 9,
      color: colors.textSecondary,
      marginBottom: 2,
    },
    chartBar: {
      width: '80%',
      backgroundColor: colors.primary,
      borderRadius: 2,
    },
    chartLabel: {
      fontSize: 9,
      color: colors.textSecondary,
      marginTop: 2,
    },
    rankRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rankNumber: {
      width: 24,
      fontSize: fontSizes.xs,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    rankLabel: {
      flex: 1,
      fontSize: fontSizes.sm,
      color: colors.text,
    },
    rankValue: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.text,
    },
    rankValueMuted: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    statusGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    statusCount: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.text,
    },
    repeatRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    repeatCell: {
      flex: 1,
      minWidth: 70,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.md,
      paddingVertical: spacing.sm,
    },
    repeatValue: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.primary,
    },
    repeatLabel: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
      marginTop: 2,
    },
  });
