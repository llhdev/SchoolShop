import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
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
  customRange,
  percentChange,
  periodRange,
  previousPeriodRange,
  PeriodKey,
  PERIODS,
  PREVIOUS_PERIOD_LABELS,
} from '../../utils/reports';
import { fetchReportStats, ReportProductRank, ReportStats } from '../../services/reportStats';
import { ALL_ORDER_STATUSES } from '../../constants/orderStatus';
import { AdminStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, pageWidth, ColorPalette } from '../../constants/theme';

type Navigation = NativeStackNavigationProp<AdminStackParamList>;

type TrendMetric = 'revenue' | 'orders';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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

/**
 * Server-aggregated reports (migration 071): every number comes from the
 * get_scoped_order_stats RPC — the client no longer downloads the order
 * history. Scoping and money stripping happen in SQL exactly like the merged
 * orders page; revenue arrives NULL for money-blind staff.
 */
export function AdminReportsScreen() {
  const navigation = useNavigation<Navigation>();
  const { products, role, staffSession, effectiveTenantId } = useApp();
  const { isDesktop, isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('orders');
  const [stats, setStats] = useState<ReportStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Same money gating as the orders page; the server also NULLs the revenue
  // fields, so treat null as hidden everywhere (both checks stay).
  const canSeeMoney = role === 'super_admin' || !!staffSession?.capabilities.financial;

  const custom = useMemo(() => customRange(customStart, customEnd), [customStart, customEnd]);
  const customInvalid = period === 'custom' && custom.invalid;
  // One date typed, the other still empty: no fetch yet, no error.
  const waitingForCustomInput = period === 'custom' && !custom.invalid && !custom.range;

  const range = useMemo(
    () => (period === 'custom' ? custom.range : periodRange(period)),
    [period, custom]
  );
  const prevRange = useMemo(
    () =>
      period === 'custom'
        ? previousPeriodRange('custom', new Date(), custom.range)
        : previousPeriodRange(period),
    [period, custom]
  );
  const previousLabel = PREVIOUS_PERIOD_LABELS[period];

  useEffect(() => {
    if (customInvalid || waitingForCustomInput) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchReportStats({
      tenantId: effectiveTenantId,
      from: range ? new Date(range[0]).toISOString() : null,
      to: range ? new Date(range[1]).toISOString() : null,
      prevFrom: prevRange ? new Date(prevRange[0]).toISOString() : null,
      prevTo: prevRange ? new Date(prevRange[1]).toISOString() : null,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
      trendMode: period,
    })
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load reports. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, prevRange, period, effectiveTenantId, reloadKey, customInvalid, waitingForCustomInput]);

  // Dead stock reads the live catalog (scoped to the shop), not the sales
  // lines — a product that never sold leaves no trace in orders. Sold units
  // come from the RPC's product_ranks (current period).
  const scopedProducts = useMemo(
    () =>
      role === 'super_admin'
        ? products
        : products.filter((p) => p.ownerId === effectiveTenantId),
    [products, role, effectiveTenantId]
  );
  const soldUnitsByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const rank of stats?.productRanks ?? []) {
      map.set(rank.productId, (map.get(rank.productId) ?? 0) + rank.units);
    }
    return map;
  }, [stats]);
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

  const summary = stats?.current ?? null;
  const previousSummary = stats?.previous ?? null;
  // Status counts reflect the CURRENT state of every in-scope item (all time),
  // so they ignore the period filter (pending doubling as the to-do list).
  const statusCounts = stats?.statusCounts ?? null;
  const isEmpty =
    !!statusCounts && ALL_ORDER_STATUSES.every((s) => (statusCounts[s] ?? 0) === 0);
  const repeatRatePct =
    summary && summary.customers > 0
      ? Math.round((summary.repeatCustomers / summary.customers) * 100)
      : 0;
  const locations = (stats?.locations ?? []).slice(0, LOCATION_COUNT);

  const isWeb = Platform.OS === 'web';

  function renderHotList(title: string, items: ReportProductRank[]) {
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
                {item.units} sold{canSeeMoney && item.revenue != null ? ` · ${formatPrice(item.revenue)}` : ''}
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
      <Screen noPadding edges={['left', 'right', 'bottom']}>
        <View style={styles.container}>
          <Text style={[styles.title, isPhone && styles.titleCompact]}>Reports</Text>
          <Text style={styles.subtitle}>
            {role === 'super_admin'
              ? 'Sales analytics across every shop.'
              : "Sales analytics for your shop's orders."}
          </Text>

          {/* Sticky period selector: rendered OUTSIDE the ScrollView below, so
              the bar stays visible while the reports scroll beneath it. */}
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
            {loading && !!stats && (
              <ActivityIndicator size="small" color={colors.primary} style={styles.refetchSpinner} />
            )}
          </View>
          {period === 'custom' && (
            <View style={styles.customRow}>
              <TextInput
                style={styles.dateInput}
                value={customStart}
                onChangeText={setCustomStart}
                placeholder="From YYYY-MM-DD"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.customSep}>to</Text>
              <TextInput
                style={styles.dateInput}
                value={customEnd}
                onChangeText={setCustomEnd}
                placeholder="To YYYY-MM-DD"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {customInvalid && (
                <Text style={styles.dateError}>
                  Use YYYY-MM-DD for both dates, from before to.
                </Text>
              )}
            </View>
          )}

          <ScrollView
            style={styles.contentScroll}
            contentContainerStyle={styles.contentScrollContent}
          >
            {loading && !stats ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={styles.loadingText}>Loading reports…</Text>
              </View>
            ) : error && !stats ? (
              <EmptyState
                message={error}
                icon="alert-circle-outline"
                actionLabel="Try again"
                onAction={() => setReloadKey((k) => k + 1)}
              />
            ) : !stats || !summary || !statusCounts || isEmpty ? (
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
                      previousLabel && previousSummary?.units != null
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
                      previousLabel && previousSummary?.orders != null
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
                      previousLabel && previousSummary?.customers != null
                        ? percentChange(summary.customers, previousSummary.customers)
                        : null
                    }
                    suffix={previousLabel ?? ''}
                    colors={colors}
                  />
                </View>
                {canSeeMoney && summary.revenue != null && (
                  <View style={styles.statWrap}>
                    <StatCard value={formatPrice(summary.revenue)} label="Revenue" />
                    <DeltaText
                      value={
                        previousLabel && previousSummary?.revenue != null
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
                  <View style={styles.trendToggle}>
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
                {stats.trend.length === 0 ? (
                  <Text style={styles.mutedText}>No sales yet.</Text>
                ) : (
                  <BarChart
                    data={stats.trend.map((b) => ({
                      label: b.label,
                      value: trendMetric === 'revenue' && canSeeMoney ? (b.revenue ?? 0) : b.orders,
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
                {renderHotList('Top 10 this week', stats.hotWeek)}
                {renderHotList('Top 10 this month', stats.hotMonth)}
              </View>

              {/* 4. Units per product */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Units sold per product</Text>
                {stats.productRanks.length === 0 ? (
                  <Text style={styles.mutedText}>No sales in this period.</Text>
                ) : (
                  stats.productRanks.map((item, index) => (
                    <View key={item.productId} style={styles.rankRow}>
                      <Text style={styles.rankNumber}>{index + 1}</Text>
                      <Text style={styles.rankLabel} numberOfLines={1}>
                        {item.label}
                      </Text>
                      <Text style={styles.rankValue}>
                        {item.units} sold{canSeeMoney && item.revenue != null ? ` · ${formatPrice(item.revenue)}` : ''}
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
                        <Text style={styles.statusCount}>{statusCounts[status] ?? 0}</Text>
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
                    value={`${repeatRatePct}%`}
                    label={`Repeat (${summary.repeatCustomers} of ${summary.customers})`}
                  />
                </View>
                <Text style={[styles.cardSubtitle, styles.cardSubtitleSpaced]}>
                  Repeat rate by month — share of the month's customers with 2+ orders by
                  month-end.
                </Text>
                <View style={styles.repeatRow}>
                  {stats.monthlyRepeat.map((month, i) => (
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
                    data={stats.weekdayCounts.map((count, i) => ({
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
                    data={stats.hourCounts.map((count, i) => ({ label: `${i}`, value: count }))}
                    formatValue={(v) => String(v)}
                    colors={colors}
                    styles={styles}
                    labelEvery={3}
                  />
                </View>
              </View>
            </>
            )}
          </ScrollView>
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
      paddingTop: spacing.md,
    },
    contentScroll: {
      flex: 1,
    },
    contentScrollContent: {
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
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    refetchSpinner: {
      marginLeft: spacing.xs,
    },
    customRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    dateInput: {
      width: 150,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      fontSize: fontSizes.sm,
      color: colors.text,
      ...(Platform.OS === 'web'
        ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
        : {}),
    },
    customSep: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    dateError: {
      fontSize: fontSizes.xs,
      color: colors.danger,
      fontWeight: '600',
    },
    loadingWrap: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.xxl,
      gap: spacing.md,
    },
    loadingText: {
      fontSize: fontSizes.md,
      color: colors.textSecondary,
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
    trendToggle: {
      flexDirection: 'row',
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
