import { useEffect, useMemo, useState } from 'react';
import {
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
import { SearchBar } from '../../components/SearchBar';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { downloadAnalysisExcel } from '../../utils/exportAnalysis';
import { formatVariantLabel, getUnitPrice } from '../../utils/variants';
import { getItemStatus, getOrderItemsForTenant } from '../../services/orders';
import { fetchShoppersByTelegramIds } from '../../services/telegramAuth';
import { ORDER_STATUSES, ORDER_STATUS_LABELS } from '../../constants/orderStatus';
import { OrderStatus, Shopper } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 1200;
const NAME_LABEL = /name/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Merge question labels that differ only by separators/casing
 * ("Grade Section", "Grade & Section", "Grade - Section") into one column.
 */
function canonicalQuestionLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[&-]+/g, ' ').replace(/\s+/g, ' ');
}

/** One row per merchant line item: checkout answers live on the cart line. */
export interface AnalysisRow {
  key: string;
  orderId: string;
  createdAt: string;
  location: string;
  phoneNumber: string;
  telegramId?: number;
  /** Tenant shop name stamped on the item snapshot (super-admin grouping). */
  shopName: string;
  productLabel: string;
  quantity: number;
  /** unitPrice × quantity, for per-store revenue on the super-admin store list. */
  lineTotal: number;
  studentName: string;
  /** Effective per-item status (falls back to the order-level status). */
  status: OrderStatus;
  /** Checkout-question answers keyed by canonical label, excluding the name-like one. */
  answers: Record<string, string>;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

type DateFilter = 'all' | 'today' | 'week' | 'month' | 'custom';

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom range' },
];

const PAGE_SIZES = [25, 50, 100, 200];

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
  const [sort, setSort] = useState<SortState>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [groupByStore, setGroupByStore] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [telegramNames, setTelegramNames] = useState<Map<number, Shopper>>(new Map());

  // Tenant admins are scoped to their own line items (mixed orders included);
  // the super admin sees every shop's items.
  const scopedTenantId = role === 'admin' ? currentUserId : null;

  const dateRange = useMemo(
    () => computeDateRange(dateFilter, customStart, customEnd),
    [dateFilter, customStart, customEnd]
  );
  const customRangeInvalid =
    dateFilter === 'custom' &&
    (customStart.trim() !== '' || customEnd.trim() !== '') &&
    dateRange === null;
  const inDateRange = (createdAt: string) => {
    if (!dateRange) return true;
    const t = new Date(createdAt).getTime();
    return t >= dateRange[0] && t <= dateRange[1];
  };

  const { rows, questionLabels, questionDisplay } = useMemo(() => {
    const rows: AnalysisRow[] = [];
    const questionLabels: string[] = [];
    // First-seen original label per canonical key, used as the column header.
    const questionDisplay = new Map<string, string>();
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
          const key = canonicalQuestionLabel(answer.label);
          if (!questionDisplay.has(key)) {
            questionDisplay.set(key, answer.label.trim());
            questionLabels.push(key);
          }
          if (!answers[key]) answers[key] = answer.value.trim();
        }
        if (!studentName && order.studentName) studentName = order.studentName;
        const product = item.product as { shop_name?: string; shopName?: string };
        rows.push({
          key: `${order.id}:${index}`,
          orderId: order.id,
          createdAt: order.createdAt,
          location: order.location,
          phoneNumber: order.phoneNumber,
          telegramId: order.telegramId,
          shopName: product.shop_name ?? product.shopName ?? 'Unknown store',
          productLabel: `${item.product.name}${variant ? ` (${variant})` : ''}`,
          quantity: item.quantity,
          lineTotal: getUnitPrice(item) * item.quantity,
          studentName,
          status: getItemStatus(order, item),
          answers,
        });
      });
    }
    return { rows, questionLabels, questionDisplay };
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
      if (!inDateRange(order.createdAt)) continue;
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
    // inDateRange only reads dateRange (a dep).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, scopedTenantId, dateRange]);

  const telegramNameFor = (row: AnalysisRow) =>
    telegramName(row.telegramId != null ? telegramNames.get(row.telegramId) : undefined);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = rows.filter((r) => inDateRange(r.createdAt));
    if (q) {
      base = base.filter((r) => {
        const haystack = [
          r.orderId,
          r.phoneNumber,
          r.location,
          r.productLabel,
          r.studentName,
          ORDER_STATUS_LABELS[r.status],
          telegramNameFor(r),
          ...Object.values(r.answers),
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    if (!sort) return base;
    // Status sorts by lifecycle order (pending -> completed), not alphabetically.
    const value = (r: AnalysisRow): string => {
      switch (sort.key) {
        case 'order': return r.orderId;
        case 'date': return r.createdAt;
        case 'location': return r.location;
        case 'phone': return r.phoneNumber;
        case 'name': return telegramNameFor(r);
        case 'student': return r.studentName;
        case 'product': return r.productLabel;
        case 'quantity': return String(r.quantity).padStart(8, '0');
        case 'status': return String(ORDER_STATUSES.indexOf(r.status));
        default: return r.answers[sort.key] ?? '';
      }
    };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...base].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    // telegramNameFor/inDateRange only read memo deps (telegramNames, dateRange).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, sort, telegramNames, dateRange]);

  // Super admin only: "Group by store" is a drill-down — first a list of stores,
  // then the analysis table of the selected store only.
  const storeSummaries = useMemo(() => {
    if (role !== 'super_admin' || !groupByStore) return null;
    const byShop = new Map<
      string,
      { shopName: string; items: number; orderIds: Set<string>; revenue: number }
    >();
    for (const row of filtered) {
      let entry = byShop.get(row.shopName);
      if (!entry) {
        entry = { shopName: row.shopName, items: 0, orderIds: new Set(), revenue: 0 };
        byShop.set(row.shopName, entry);
      }
      entry.items += 1;
      entry.orderIds.add(row.orderId);
      entry.revenue += row.lineTotal;
    }
    return [...byShop.values()].sort((a, b) => a.shopName.localeCompare(b.shopName));
  }, [role, groupByStore, filtered]);

  const displayedRows = useMemo(
    () =>
      selectedStore ? filtered.filter((r) => r.shopName === selectedStore) : filtered,
    [filtered, selectedStore]
  );

  // Any filter/search/sort/store/page-size change goes back to page 1.
  useEffect(() => {
    setPage(1);
  }, [query, sort, dateRange, selectedStore, pageSize]);

  const pageCount = Math.max(1, Math.ceil(displayedRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = displayedRows.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const isWeb = Platform.OS === 'web';

  function toggleSort(key: string) {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    );
  }

  const [downloading, setDownloading] = useState(false);
  async function handleDownload() {
    setDownloading(true);
    try {
      await downloadAnalysisExcel(displayedRows, questionLabels, questionDisplay, telegramNameFor);
    } finally {
      setDownloading(false);
    }
  }

  function renderCard(row: AnalysisRow) {
    const fields: [string, string][] = [
      ['Order #', row.orderId],
      ['Date & time', new Date(row.createdAt).toLocaleString()],
      ['Phone', row.phoneNumber],
      ['Telegram Name', telegramNameFor(row)],
      ['Student name', row.studentName || '—'],
      ['Product', row.productLabel],
      ['Quantity', String(row.quantity)],
      ['Status', ORDER_STATUS_LABELS[row.status]],
      ...questionLabels.map(
        (label): [string, string] => [questionDisplay.get(label) ?? label, row.answers[label] ?? '—']
      ),
      ['Location', row.location || '—'],
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

  function cell(text: string, width: { width: number }, key: string) {
    return (
      <Text key={key} style={[styles.cell, width]} numberOfLines={2}>
        {text}
      </Text>
    );
  }

  function headerCell(label: string, sortKey: string, width: { width: number }) {
    const active = sort?.key === sortKey;
    return (
      <TouchableOpacity
        key={sortKey}
        style={[styles.headerCell, width]}
        onPress={() => toggleSort(sortKey)}
      >
        <Text
          style={[styles.cell, styles.headerText, active && styles.headerTextActive]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {active && (
          <Ionicons
            name={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'}
            size={12}
            color={colors.primary}
          />
        )}
      </TouchableOpacity>
    );
  }

  const isEmpty = rows.length === 0;
  const showStoreList = storeSummaries !== null && selectedStore === null;

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
            {/* Revenue is super-admin-only for now; merchants see Shoppers + Orders. */}
            {role === 'super_admin' && (
              <View style={styles.statCard}>
                <Text style={styles.statValue}>{formatPrice(summary.revenue)}</Text>
                <Text style={styles.statLabel}>Revenue</Text>
              </View>
            )}
          </View>

          <SearchBar
            value={query}
            onChangeText={setQuery}
            placeholder="Search orders, shoppers, products..."
          />

          <View style={styles.filterRow}>
            {DATE_FILTERS.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.chip, dateFilter === f.key && styles.chipActive]}
                onPress={() => setDateFilter(f.key)}
              >
                <Text style={[styles.chipText, dateFilter === f.key && styles.chipTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
            {role === 'super_admin' && (
              <TouchableOpacity
                style={[styles.chip, groupByStore && styles.chipActive]}
                onPress={() => {
                  setGroupByStore((v) => !v);
                  setSelectedStore(null);
                }}
              >
                <Ionicons
                  name="storefront-outline"
                  size={14}
                  color={groupByStore ? colors.surface : colors.text}
                />
                <Text style={[styles.chipText, groupByStore && styles.chipTextActive]}>
                  Group by store
                </Text>
              </TouchableOpacity>
            )}
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
              <Text style={styles.customSep}>→</Text>
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

          {isWeb && !showStoreList && displayedRows.length > 0 && (
            <TouchableOpacity
              style={styles.downloadButton}
              onPress={handleDownload}
              disabled={downloading}
            >
              <Ionicons name="download-outline" size={16} color={colors.primary} />
              <Text style={styles.downloadText}>
                {downloading ? 'Preparing…' : `Download Excel (${displayedRows.length} rows)`}
              </Text>
            </TouchableOpacity>
          )}

          {isEmpty ? (
            <EmptyState
              message="No orders yet — they appear here once customers buy something."
              icon="receipt-outline"
            />
          ) : filtered.length === 0 ? (
            <EmptyState message="No rows match your filters." icon="search-outline" />
          ) : showStoreList && storeSummaries ? (
            <View style={styles.storeList}>
              {storeSummaries.map((store) => (
                <TouchableOpacity
                  key={store.shopName}
                  style={styles.storeCard}
                  onPress={() => setSelectedStore(store.shopName)}
                >
                  <View style={styles.storeCardIcon}>
                    <Ionicons name="storefront-outline" size={22} color={colors.primary} />
                  </View>
                  <View style={styles.storeCardBody}>
                    <Text style={styles.storeCardName}>{store.shopName}</Text>
                    <Text style={styles.storeCardMeta}>
                      {store.items} items · {store.orderIds.size} orders · {formatPrice(store.revenue)}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <>
              {selectedStore && (
                <View style={styles.storeHeader}>
                  <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => setSelectedStore(null)}
                  >
                    <Ionicons name="chevron-back" size={16} color={colors.primary} />
                    <Text style={styles.backButtonText}>All stores</Text>
                  </TouchableOpacity>
                  <Text style={styles.storeHeaderName}>{selectedStore}</Text>
                </View>
              )}
              {isPhone ? (
                <View style={styles.cardList}>{pageRows.map(renderCard)}</View>
              ) : (
            <ScrollView horizontal style={styles.tableScroll}>
              <View style={styles.table}>
                <View style={[styles.trow, styles.thead]}>
                  {headerCell('Order #', 'order', styles.wOrder)}
                  {headerCell('Date & time', 'date', styles.wDate)}
                  {headerCell('Phone', 'phone', styles.wPhone)}
                  {headerCell('Telegram Name', 'name', styles.wName)}
                  {headerCell('Student name', 'student', styles.wName)}
                  {headerCell('Product', 'product', styles.wProduct)}
                  {headerCell('Quantity', 'quantity', styles.wQty)}
                  {headerCell('Status', 'status', styles.wStatus)}
                  {questionLabels.map((label) =>
                    headerCell(questionDisplay.get(label) ?? label, label, styles.wQuestion)
                  )}
                  {headerCell('Location', 'location', styles.wLocation)}
                </View>
                {pageRows.map((row) => (
                  <TouchableOpacity
                    key={row.key}
                    style={styles.trow}
                    onPress={() => navigation.navigate('OrderDetail', { orderId: row.orderId })}
                  >
                    {cell(row.orderId, styles.wOrder, `${row.key}-order`)}
                    {cell(new Date(row.createdAt).toLocaleString(), styles.wDate, `${row.key}-date`)}
                    {cell(row.phoneNumber, styles.wPhone, `${row.key}-phone`)}
                    {cell(telegramNameFor(row), styles.wName, `${row.key}-name`)}
                    {cell(row.studentName || '—', styles.wName, `${row.key}-student`)}
                    {cell(row.productLabel, styles.wProduct, `${row.key}-product`)}
                    {cell(String(row.quantity), styles.wQty, `${row.key}-qty`)}
                    {cell(ORDER_STATUS_LABELS[row.status], styles.wStatus, `${row.key}-status`)}
                    {questionLabels.map((label) =>
                      cell(row.answers[label] ?? '—', styles.wQuestion, `${row.key}-${label}`)
                    )}
                    {cell(row.location || '—', styles.wLocation, `${row.key}-location`)}
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
              )}
              <View style={styles.pagerRow}>
                <Text style={styles.pagerLabel}>Rows per page</Text>
                {PAGE_SIZES.map((size) => (
                  <TouchableOpacity
                    key={size}
                    style={[styles.chip, pageSize === size && styles.chipActive]}
                    onPress={() => setPageSize(size)}
                  >
                    <Text
                      style={[styles.chipText, pageSize === size && styles.chipTextActive]}
                    >
                      {size}
                    </Text>
                  </TouchableOpacity>
                ))}
                <View style={styles.pagerSpacer} />
                <TouchableOpacity
                  style={[styles.pagerButton, currentPage <= 1 && styles.pagerButtonDisabled]}
                  onPress={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                >
                  <Ionicons
                    name="chevron-back"
                    size={14}
                    color={currentPage <= 1 ? colors.textSecondary : colors.primary}
                  />
                  <Text
                    style={[
                      styles.pagerButtonText,
                      currentPage <= 1 && styles.pagerButtonTextDisabled,
                    ]}
                  >
                    Prev
                  </Text>
                </TouchableOpacity>
                <Text style={styles.pagerInfo}>
                  Page {currentPage} of {pageCount}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.pagerButton,
                    currentPage >= pageCount && styles.pagerButtonDisabled,
                  ]}
                  onPress={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={currentPage >= pageCount}
                >
                  <Text
                    style={[
                      styles.pagerButtonText,
                      currentPage >= pageCount && styles.pagerButtonTextDisabled,
                    ]}
                  >
                    Next
                  </Text>
                  <Ionicons
                    name="chevron-forward"
                    size={14}
                    color={currentPage >= pageCount ? colors.textSecondary : colors.primary}
                  />
                </TouchableOpacity>
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
    filterRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
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
    storeList: {
      marginTop: spacing.md,
      gap: spacing.sm,
    },
    storeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    storeCardIcon: {
      width: 40,
      height: 40,
      borderRadius: borderRadius.md,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    storeCardBody: {
      flex: 1,
    },
    storeCardName: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.text,
    },
    storeCardMeta: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
      marginTop: 2,
    },
    storeHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingVertical: spacing.xs,
      paddingRight: spacing.sm,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    backButtonText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
    },
    storeHeaderName: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
    },
    pagerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    pagerLabel: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    pagerSpacer: {
      flex: 1,
    },
    pagerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: borderRadius.sm,
      borderWidth: 1,
      borderColor: colors.primary,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    pagerButtonDisabled: {
      borderColor: colors.border,
    },
    pagerButtonText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
    },
    pagerButtonTextDisabled: {
      color: colors.textSecondary,
    },
    pagerInfo: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
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
    headerCell: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingRight: spacing.xs,
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
    },
    headerText: {
      fontWeight: '700',
      color: colors.textSecondary,
      flexShrink: 1,
    },
    headerTextActive: {
      color: colors.primary,
    },
    wOrder: { width: 100 },
    wDate: { width: 170 },
    wLocation: { width: 170 },
    wPhone: { width: 120 },
    wName: { width: 150 },
    wProduct: { width: 220 },
    wQty: { width: 90 },
    wStatus: { width: 130 },
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
