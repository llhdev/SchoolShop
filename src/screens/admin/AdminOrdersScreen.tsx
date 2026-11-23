import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { Chip } from '../../components/Chip';
import { SearchBar } from '../../components/SearchBar';
import { StatCard } from '../../components/StatCard';
import { Button } from '../../components/Button';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { PaymentWarningBadge } from '../../components/PaymentWarningBadge';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { canonicalAnswers, canonicalQuestionLabel, downloadOrderLinesExcel } from '../../utils/exportAnalysis';
import { notify } from '../../utils/notify';
import { getOrderItemsForTenant } from '../../services/orders';
import { fetchScopedOrderLines, OrderLineRow } from '../../services/orderLines';
import { fetchTenants, Tenant } from '../../services/tenants';
import { AdminStackParamList, RootStackParamList } from '../../types/navigation';
import { OrderStatus } from '../../types';
import { ORDER_STATUS_LABELS } from '../../constants/orderStatus';
import { useThemeColors, spacing, borderRadius, fontSizes, pageWidth, ColorPalette } from '../../constants/theme';

type StatusFilter = OrderStatus | 'all' | 'needs_review';

type DateFilter = 'all' | 'today' | 'week' | 'month' | 'custom';

/** Page sizes are ORDERS (not lines) per page — the RPC paginates BY ORDER
 *  and expands each page order into its visible line rows, so one page's
 *  lines stay together. */
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
/** Non-financial staff get no realtime order events (064), so the merged page
 *  polls the FIRST page on this cadence for every role — one path for all. */
const POLL_MS = 15000;
/** Export safety valve: stops chunking far beyond any realistic shop history. */
const EXPORT_MAX_ROWS = 50000;

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_FILTERS: { key: StatusFilter; label: string; financialOnly?: boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: ORDER_STATUS_LABELS.pending },
  { key: 'received', label: ORDER_STATUS_LABELS.received },
  { key: 'paid', label: ORDER_STATUS_LABELS.paid, financialOnly: true },
  { key: 'on_the_way', label: ORDER_STATUS_LABELS.on_the_way },
  { key: 'completed', label: ORDER_STATUS_LABELS.completed },
  { key: 'cancelled', label: ORDER_STATUS_LABELS.cancelled },
  { key: 'needs_review', label: 'Needs review', financialOnly: true },
];

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom range' },
];

/** Parse "YYYY-MM-DD" as local midnight (Date.parse would treat it as UTC). */
function parseDateInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const time = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isNaN(time) ? null : time;
}

/** [startMs, endMs] inclusive in local time; null = no date filtering.
 *  An incomplete/invalid custom range also yields null (no filtering). */
function computeDateRange(
  filter: DateFilter,
  customStart: string,
  customEnd: string
): [number, number] | null {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const endOfToday = startOfDay(now) + DAY_MS - 1;
  switch (filter) {
    case 'today':
      return [startOfDay(now), endOfToday];
    case 'week': {
      // Week starts on Monday.
      const sinceMonday = (now.getDay() + 6) % 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
      return [startOfDay(monday), endOfToday];
    }
    case 'month':
      return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), endOfToday];
    case 'custom': {
      const start = parseDateInput(customStart);
      const end = parseDateInput(customEnd);
      if (start === null || end === null) return null;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      return [lo, hi + DAY_MS - 1];
    }
    default:
      return null;
  }
}

function telegramName(row: OrderLineRow): string {
  const full = [row.telegramFirstName, row.telegramLastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  return row.telegramUsername ? `@${row.telegramUsername}` : '—';
}

/** Checkout-question columns present in a row set: canonical label keys in
 *  first-seen order plus the first-seen original label for the header. */
function collectQuestions(rows: OrderLineRow[]): {
  questionLabels: string[];
  questionDisplay: Map<string, string>;
} {
  const questionLabels: string[] = [];
  const questionDisplay = new Map<string, string>();
  for (const row of rows) {
    for (const answer of row.fieldAnswers) {
      if (!answer.value.trim()) continue;
      const key = canonicalQuestionLabel(answer.label);
      if (!questionDisplay.has(key)) {
        questionDisplay.set(key, answer.label.trim());
        questionLabels.push(key);
      }
    }
  }
  return { questionLabels, questionDisplay };
}

/**
 * Merged admin orders page (migration 070): the old operational Orders list
 * and the Shopper Analysis table in one server-paginated line-item table.
 * All filtering, search, scoping and money stripping happen in the
 * get_scoped_order_lines RPC — the client never downloads the full history.
 */
export function AdminOrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminStackParamList & RootStackParamList>>();
  const { orders, role, staffSession, effectiveTenantId } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const isSuperAdmin = role === 'super_admin';
  // Money is visible to the super admin and financial staff only (045/064).
  const canSeeMoney = isSuperAdmin || !!staffSession?.capabilities.financial;

  // Super admin: pick a shop first, then browse that shop's line items.
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantsFailed, setTenantsFailed] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [dateDropdownOpen, setDateDropdownOpen] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  // Orders per page (the RPC paginates by order); changing this refetches page 1.
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const [pages, setPages] = useState<OrderLineRow[][]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalRevenue, setTotalRevenue] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  const loadShops = useCallback(() => {
    setTenantsFailed(false);
    fetchTenants()
      .then(setTenants)
      .catch(() => setTenantsFailed(true));
  }, []);

  useEffect(() => {
    if (isSuperAdmin) loadShops();
  }, [isSuperAdmin, loadShops]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const selectedTenant = isSuperAdmin
    ? tenants.find((t) => t.id === selectedTenantId) ?? null
    : null;

  // Staff are scoped to their own shop server-side (p_tenant_id is ignored for
  // them); the super admin's picked shop is passed through.
  const activeTenantId = isSuperAdmin ? selectedTenantId : effectiveTenantId;

  const dateRange = useMemo(
    () => computeDateRange(dateFilter, customStart, customEnd),
    [dateFilter, customStart, customEnd]
  );
  const customRangeInvalid =
    dateFilter === 'custom' &&
    (customStart.trim() !== '' || customEnd.trim() !== '') &&
    dateRange === null;

  const buildQuery = useCallback(
    (after?: { createdAt: string; id: string }) => ({
      tenantId: activeTenantId,
      status: statusFilter === 'all' ? null : statusFilter,
      from: dateRange ? new Date(dateRange[0]).toISOString() : null,
      to: dateRange ? new Date(dateRange[1]).toISOString() : null,
      search: debouncedQuery.trim() || null,
      afterCreatedAt: after?.createdAt ?? null,
      afterId: after?.id ?? null,
      limit: pageSize,
    }),
    [activeTenantId, statusFilter, dateRange, debouncedQuery, pageSize]
  );

  /** mode 'initial' resets the list (filter change / retry); 'poll' silently
   *  replaces only the first page so appended pages survive the refresh. */
  const loadFirstPage = useCallback(
    async (mode: 'initial' | 'poll') => {
      if (!activeTenantId) return;
      if (mode === 'initial') {
        setLoading(true);
        setError('');
      }
      try {
        const page = await fetchScopedOrderLines(buildQuery());
        setPages((prev) => (mode === 'initial' ? [page.rows] : [page.rows, ...prev.slice(1)]));
        setTotalCount(page.totalCount);
        setTotalRevenue(page.totalRevenue);
        setHasMore(page.hasMore);
      } catch {
        if (mode === 'initial') {
          setPages([]);
          setError('Failed to load orders. Please try again.');
        }
        // Poll failures keep the current data.
      } finally {
        if (mode === 'initial') setLoading(false);
      }
    },
    [activeTenantId, buildQuery]
  );

  // Refetch page 1 on any filter/search/date/tenant change.
  useEffect(() => {
    loadFirstPage('initial');
  }, [loadFirstPage]);

  // Freshness poll — the first page only (see POLL_MS comment).
  useEffect(() => {
    if (!activeTenantId) return;
    const timer = setInterval(() => {
      loadFirstPage('poll').catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadFirstPage, activeTenantId]);

  const rows = useMemo(() => pages.flat(), [pages]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || rows.length === 0) return;
    setLoadingMore(true);
    try {
      const last = rows[rows.length - 1];
      const page = await fetchScopedOrderLines(
        buildQuery({ createdAt: last.createdAt, id: last.orderId })
      );
      setPages((prev) => [...prev, page.rows]);
      setHasMore(page.hasMore);
    } catch {
      notify('Failed to load more orders. Please try again.', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, rows, buildQuery]);

  const { questionLabels, questionDisplay } = useMemo(() => collectQuestions(rows), [rows]);

  // The Branch column only appears when at least one visible row has one.
  const hasBranches = useMemo(() => rows.some((r) => !!r.branchName), [rows]);

  /** Web Excel export: fetch EVERY page matching the current filters from the
   *  RPC in chunks (never the context cache), then hand the rows to SheetJS. */
  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const all: OrderLineRow[] = [];
      let after: { createdAt: string; id: string } | undefined;
      for (;;) {
        const page = await fetchScopedOrderLines(buildQuery(after));
        all.push(...page.rows);
        if (!page.hasMore || page.rows.length === 0 || all.length >= EXPORT_MAX_ROWS) break;
        const last = page.rows[page.rows.length - 1];
        after = { createdAt: last.createdAt, id: last.orderId };
      }
      const questions = collectQuestions(all);
      await downloadOrderLinesExcel(
        all,
        questions.questionLabels,
        questions.questionDisplay,
        canSeeMoney,
        all.some((r) => !!r.branchName)
      );
    } catch {
      notify('Export failed. Please try again.', 'error');
    } finally {
      setExporting(false);
    }
  }

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

  const isWeb = Platform.OS === 'web';

  // Super admin entry point: the list of shops, each leading to that shop's
  // orders. Tenant admins land directly on their own shop's line table.
  if (isSuperAdmin && !selectedTenantId) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen noPadding edges={['top', 'left', 'right', 'bottom']}>
          <View style={styles.container}>
            <Text style={[styles.title, isPhone && styles.titleCompact]}>Orders by Shop</Text>
            {tenantsFailed ? (
              <EmptyState
                message="Failed to load shops. Please try again."
                icon="storefront-outline"
                actionLabel="Try again"
                onAction={loadShops}
              />
            ) : tenants.length === 0 ? (
              <EmptyState message="No tenants yet." icon="storefront-outline" />
            ) : (
              <ScrollView style={styles.shopList}>
                {tenants.map((tenant) => {
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
                })}
              </ScrollView>
            )}
          </View>
        </Screen>
      </>
    );
  }

  function statusCell(row: OrderLineRow) {
    return (
      <View style={styles.statusCell}>
        <OrderStatusBadge status={row.lineStatus} small />
        {canSeeMoney && row.paymentWarning && (
          <PaymentWarningBadge reason={row.paymentWarning.reason} />
        )}
      </View>
    );
  }

  function renderCard(row: OrderLineRow) {
    const answers = canonicalAnswers(row);
    const fields: [string, string][] = [
      ['Order #', row.orderId],
      ['Date & time', new Date(row.createdAt).toLocaleString()],
      ['Phone', row.phoneNumber],
      ['Telegram Name', telegramName(row)],
      ['Product', row.productName],
      ['Quantity', String(row.quantity)],
      ...(canSeeMoney
        ? ([
            ['Unit price', row.unitPrice != null ? formatPrice(row.unitPrice) : '—'],
            ['Line total', row.lineTotal != null ? formatPrice(row.lineTotal) : '—'],
          ] as [string, string][])
        : []),
      ...(hasBranches ? ([['Branch', row.branchName || '—']] as [string, string][]) : []),
      ...questionLabels.map(
        (label): [string, string] => [questionDisplay.get(label) ?? label, answers[label] ?? '—']
      ),
      ['Location', row.location || '—'],
    ];
    return (
      <TouchableOpacity
        key={`${row.orderId}:${row.itemKey}`}
        style={styles.card}
        onPress={() => navigation.navigate('OrderDetail', { orderId: row.orderId })}
      >
        <View style={styles.cardStatusRow}>
          <Text style={styles.cardStatusLabel}>Status</Text>
          {statusCell(row)}
        </View>
        {fields.map(([label, value]) => (
          <View key={label} style={styles.cardField}>
            <Text style={styles.cardLabel}>{label}</Text>
            <Text style={styles.cardValue}>{value}</Text>
          </View>
        ))}
      </TouchableOpacity>
    );
  }

  function headerCell(label: string, width: { width: number }, key: string) {
    return (
      <Text key={key} style={[styles.cell, styles.headerText, width]} numberOfLines={1}>
        {label}
      </Text>
    );
  }

  function cell(text: string, width: { width: number }, key: string) {
    return (
      <Text key={key} style={[styles.cell, width]} numberOfLines={2}>
        {text}
      </Text>
    );
  }

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen scroll noPadding edges={['left', 'right', 'bottom']}>
        <View style={styles.container}>
          {isSuperAdmin && (
            <TouchableOpacity style={styles.backRow} onPress={() => setSelectedTenantId(null)}>
              <Ionicons name="chevron-back" size={20} color={colors.primary} />
              <Text style={styles.backText}>All shops</Text>
            </TouchableOpacity>
          )}
          <Text style={[styles.title, isPhone && styles.titleCompact]}>
            {isSuperAdmin ? (selectedTenant?.shopName ?? 'Orders') : 'Orders'}
          </Text>
          <Text style={styles.subtitle}>
            Every item ordered from this shop, one row per item.
          </Text>

          <View style={styles.statsRow}>
            <StatCard value={totalCount} label="Line items" />
            {canSeeMoney && (
              <StatCard value={formatPrice(totalRevenue ?? 0)} label="Revenue" />
            )}
          </View>

          <View style={styles.toolbar}>
            <View style={styles.toolbarSearch}>
              <SearchBar
                value={query}
                onChangeText={setQuery}
                placeholder="Search orders, phones, products, locations..."
              />
            </View>
            {/* Date filter dropdown — the codebase's inline-expand pattern
                (see CheckoutScreen); filters the table, stat cards and export. */}
            <TouchableOpacity
              style={styles.dateDropdownField}
              onPress={() => setDateDropdownOpen((open) => !open)}
              activeOpacity={0.7}
            >
              <Text style={styles.dateDropdownValue} numberOfLines={1}>
                Date: {DATE_FILTERS.find((f) => f.key === dateFilter)?.label ?? 'All time'}
              </Text>
              <Ionicons
                name={dateDropdownOpen ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={colors.textSecondary}
              />
            </TouchableOpacity>
          </View>
          {dateDropdownOpen && (
            <View style={styles.dateDropdownList}>
              {DATE_FILTERS.map((f) => (
                <TouchableOpacity
                  key={f.key}
                  style={[
                    styles.dateDropdownOption,
                    dateFilter === f.key && styles.dateDropdownOptionActive,
                  ]}
                  onPress={() => {
                    setDateFilter(f.key);
                    setDateDropdownOpen(false);
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.dateDropdownOptionText,
                      dateFilter === f.key && styles.dateDropdownOptionTextActive,
                    ]}
                  >
                    {f.label}
                  </Text>
                  {dateFilter === f.key && (
                    <Ionicons name="checkmark" size={16} color={colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.filterRow}>
            {STATUS_FILTERS.filter((f) => !f.financialOnly || canSeeMoney).map((filter) => (
              <Chip
                key={filter.key}
                label={filter.label}
                active={statusFilter === filter.key}
                onPress={() => setStatusFilter(filter.key)}
              />
            ))}
          </View>

          {dateFilter === 'custom' && (
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
              {customRangeInvalid && (
                <Text style={styles.dateError}>Use YYYY-MM-DD for both dates.</Text>
              )}
            </View>
          )}

          {isWeb && rows.length > 0 && (
            <TouchableOpacity
              style={styles.downloadButton}
              onPress={handleExport}
              disabled={exporting}
            >
              <Ionicons name="download-outline" size={16} color={colors.primary} />
              <Text style={styles.downloadText}>
                {exporting ? 'Preparing…' : `Download Excel (${totalCount} rows)`}
              </Text>
            </TouchableOpacity>
          )}

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>Loading orders…</Text>
            </View>
          ) : error ? (
            <EmptyState
              message={error}
              icon="alert-circle-outline"
              actionLabel="Try again"
              onAction={() => loadFirstPage('initial')}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              message={
                debouncedQuery || statusFilter !== 'all' || dateRange
                  ? 'No rows match your filters.'
                  : 'No orders yet — they appear here once customers buy something.'
              }
              icon="receipt-outline"
            />
          ) : (
            <>
              {isPhone ? (
                <View style={styles.cardList}>{rows.map(renderCard)}</View>
              ) : (
                <ScrollView horizontal style={styles.tableScroll}>
                  <View style={styles.table}>
                    <View style={[styles.trow, styles.thead]}>
                      {headerCell('Order #', styles.wOrder, 'h-order')}
                      {headerCell('Date & time', styles.wDate, 'h-date')}
                      {headerCell('Phone', styles.wPhone, 'h-phone')}
                      {headerCell('Telegram Name', styles.wName, 'h-name')}
                      {headerCell('Product', styles.wProduct, 'h-product')}
                      {headerCell('Qty', styles.wQty, 'h-qty')}
                      {canSeeMoney && headerCell('Unit price', styles.wMoney, 'h-unit')}
                      {canSeeMoney && headerCell('Line total', styles.wMoney, 'h-total')}
                      {headerCell('Status', styles.wStatus, 'h-status')}
                      {hasBranches && headerCell('Branch', styles.wName, 'h-branch')}
                      {questionLabels.map((label) =>
                        headerCell(questionDisplay.get(label) ?? label, styles.wQuestion, `h-q-${label}`)
                      )}
                      {headerCell('Location', styles.wLocation, 'h-location')}
                    </View>
                    {rows.map((row) => {
                      const answers = canonicalAnswers(row);
                      const key = `${row.orderId}:${row.itemKey}`;
                      return (
                        <TouchableOpacity
                          key={key}
                          style={styles.trow}
                          onPress={() => navigation.navigate('OrderDetail', { orderId: row.orderId })}
                        >
                          {cell(row.orderId, styles.wOrder, `${key}-order`)}
                          {cell(new Date(row.createdAt).toLocaleString(), styles.wDate, `${key}-date`)}
                          {cell(row.phoneNumber, styles.wPhone, `${key}-phone`)}
                          {cell(telegramName(row), styles.wName, `${key}-name`)}
                          {cell(row.productName, styles.wProduct, `${key}-product`)}
                          {cell(String(row.quantity), styles.wQty, `${key}-qty`)}
                          {canSeeMoney &&
                            cell(
                              row.unitPrice != null ? formatPrice(row.unitPrice) : '—',
                              styles.wMoney,
                              `${key}-unit`
                            )}
                          {canSeeMoney &&
                            cell(
                              row.lineTotal != null ? formatPrice(row.lineTotal) : '—',
                              styles.wMoney,
                              `${key}-total`
                            )}
                          <View style={[styles.cell, styles.wStatus]}>{statusCell(row)}</View>
                          {hasBranches && cell(row.branchName || '—', styles.wName, `${key}-branch`)}
                          {questionLabels.map((label) =>
                            cell(answers[label] ?? '—', styles.wQuestion, `${key}-${label}`)
                          )}
                          {cell(row.location || '—', styles.wLocation, `${key}-location`)}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>
              )}
              <View style={styles.paginationRow}>
                <Text style={styles.showingText}>
                  Showing {rows.length} of {totalCount} line items
                </Text>
                <View style={styles.pageSizeRow}>
                  <Text style={styles.pageSizeLabel}>Orders per page</Text>
                  {PAGE_SIZES.map((size) => (
                    <Chip
                      key={size}
                      label={String(size)}
                      active={pageSize === size}
                      onPress={() => setPageSize(size)}
                    />
                  ))}
                </View>
              </View>
              {hasMore && (
                <View style={styles.loadMoreRow}>
                  <Button
                    title="Load more"
                    variant="outline"
                    loading={loadingMore}
                    onPress={() => loadMore().catch(() => {})}
                    style={styles.loadMoreButton}
                  />
                </View>
              )}
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
    shopList: {
      flex: 1,
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
      flexWrap: 'wrap',
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    toolbar: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.sm,
    },
    toolbarSearch: {
      flex: 1,
      minWidth: 220,
    },
    // Compact date-filter dropdown, the codebase's inline-expand pattern
    // (CheckoutScreen's branch/question dropdowns, shrunk to toolbar size).
    dateDropdownField: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    dateDropdownValue: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.text,
    },
    dateDropdownList: {
      alignSelf: 'flex-start',
      minWidth: 180,
      marginTop: spacing.xs,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      overflow: 'hidden',
    },
    dateDropdownOption: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    dateDropdownOptionActive: {
      backgroundColor: colors.background,
    },
    dateDropdownOptionText: {
      fontSize: fontSizes.sm,
      color: colors.text,
    },
    dateDropdownOptionTextActive: {
      color: colors.primary,
      fontWeight: '600',
    },
    filterRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    customRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.sm,
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
    downloadButton: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: spacing.xs,
      marginTop: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: borderRadius.sm,
      borderWidth: 1,
      borderColor: colors.primary,
      backgroundColor: colors.surface,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    downloadText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
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
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    cardStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    cardStatusLabel: {
      width: 110,
      fontSize: fontSizes.xs,
      fontWeight: '700',
      color: colors.textSecondary,
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
    },
    cardValue: {
      flex: 1,
      fontSize: fontSizes.sm,
      color: colors.text,
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
    headerText: {
      fontWeight: '700',
      color: colors.textSecondary,
      flexShrink: 1,
    },
    statusCell: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    loadMoreRow: {
      alignItems: 'center',
      marginTop: spacing.md,
    },
    loadMoreButton: {
      minWidth: 200,
    },
    paginationRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    showingText: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    pageSizeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    pageSizeLabel: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    wOrder: { width: 100 },
    wDate: { width: 170 },
    wLocation: { width: 170 },
    wPhone: { width: 120 },
    wName: { width: 150 },
    wProduct: { width: 220 },
    wQty: { width: 60 },
    wMoney: { width: 110 },
    wStatus: { width: 170 },
    wQuestion: { width: 150 },
  });
