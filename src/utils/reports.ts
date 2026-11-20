import { Order, OrderStatus } from '../types';
import { getItemStatus, getOrderItemsForScope } from '../services/orders';
import { formatVariantLabel, getUnitPrice } from './variants';
import { ALL_ORDER_STATUSES } from '../constants/orderStatus';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One flat row per in-scope order line item — the input every report
 *  aggregates over, so each order is walked exactly once per render. */
export interface ReportLine {
  orderId: string;
  createdAt: string;
  productId: string;
  /** Product name plus variant label ("Notebook A4 (Size Large)"). */
  productLabel: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** Effective per-item status (falls back to the order-level status). */
  status: OrderStatus;
  phone: string;
  location: string;
}

/** Flatten orders into report lines, scoped exactly like the analysis and
 *  orders screens: shop accounts see their own items (branch staff further
 *  narrowed to their branch), the super admin (tenantId null) sees all. */
export function buildReportLines(
  orders: Order[],
  tenantId: string | null,
  branchId: string | null,
  branchSelectionEnabled = true
): ReportLine[] {
  const lines: ReportLine[] = [];
  for (const order of orders) {
    const items = tenantId
      ? getOrderItemsForScope(order, tenantId, branchId, branchSelectionEnabled)
      : order.items;
    for (const item of items) {
      if (!item.product) continue;
      const variant = formatVariantLabel(item);
      const unitPrice = getUnitPrice(item);
      lines.push({
        orderId: order.id,
        createdAt: order.createdAt,
        productId: item.product.id,
        productLabel: `${item.product.name}${variant ? ` (${variant})` : ''}`,
        quantity: item.quantity,
        unitPrice,
        lineTotal: unitPrice * item.quantity,
        status: getItemStatus(order, item),
        phone: order.phoneNumber,
        location: order.location,
      });
    }
  }
  return lines;
}

// --- Periods ---------------------------------------------------------------

export type PeriodKey = 'today' | 'week' | 'month' | 'all';

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
];

/** Label for the comparison period ("vs yesterday" …); null for 'all'. */
export const PREVIOUS_PERIOD_LABELS: Record<PeriodKey, string | null> = {
  today: 'vs yesterday',
  week: 'vs last week',
  month: 'vs last month',
  all: null,
};

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** [startMs, endMs] inclusive in local time; null = no date filtering.
 *  Weeks start on Monday, matching the analysis screen. */
export function periodRange(key: PeriodKey, now: Date = new Date()): [number, number] | null {
  const endOfToday = startOfDay(now) + DAY_MS - 1;
  switch (key) {
    case 'today':
      return [startOfDay(now), endOfToday];
    case 'week': {
      const sinceMonday = (now.getDay() + 6) % 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
      return [startOfDay(monday), endOfToday];
    }
    case 'month':
      return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), endOfToday];
    default:
      return null;
  }
}

/** The equivalent period immediately before the current one (yesterday,
 *  last Mon–Sun week, last calendar month); null for 'all'. */
export function previousPeriodRange(
  key: PeriodKey,
  now: Date = new Date()
): [number, number] | null {
  switch (key) {
    case 'today': {
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return [startOfDay(yesterday), startOfDay(yesterday) + DAY_MS - 1];
    }
    case 'week': {
      const sinceMonday = (now.getDay() + 6) % 7;
      const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
      const lastMonday = new Date(
        thisMonday.getFullYear(),
        thisMonday.getMonth(),
        thisMonday.getDate() - 7
      );
      return [startOfDay(lastMonday), startOfDay(thisMonday) - 1];
    }
    case 'month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return [lastFirst.getTime(), first.getTime() - 1];
    }
    default:
      return null;
  }
}

export function filterLines(lines: ReportLine[], range: [number, number] | null): ReportLine[] {
  if (!range) return lines;
  return lines.filter((line) => {
    const t = new Date(line.createdAt).getTime();
    return t >= range[0] && t <= range[1];
  });
}

// --- Aggregations ----------------------------------------------------------

export interface LineSummary {
  units: number;
  orders: number;
  revenue: number;
  customers: number;
}

export function sumLines(lines: ReportLine[]): LineSummary {
  const orderIds = new Set<string>();
  const phones = new Set<string>();
  let units = 0;
  let revenue = 0;
  for (const line of lines) {
    orderIds.add(line.orderId);
    phones.add(line.phone);
    units += line.quantity;
    revenue += line.lineTotal;
  }
  return { units, orders: orderIds.size, revenue, customers: phones.size };
}

/** % change from previous to current; null when there is no meaningful base
 *  (previous 0 — a bare "new" beats an infinite percentage). */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export interface TrendBucket {
  label: string;
  orders: number;
  revenue: number;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Fixed-coverage buckets for the trend chart so quiet days still take up
 *  their slot: today → 24 hours, week → 7 days, month → its days,
 *  all → months from the first sale to now. */
export function trendBuckets(lines: ReportLine[], period: PeriodKey, now: Date = new Date()): TrendBucket[] {
  interface BucketDef {
    label: string;
    start: number;
    end: number;
  }
  const defs: BucketDef[] = [];
  if (period === 'today') {
    const dayStart = startOfDay(now);
    for (let h = 0; h < 24; h++) {
      defs.push({ label: `${h}`, start: dayStart + h * 3600000, end: dayStart + (h + 1) * 3600000 - 1 });
    }
  } else if (period === 'week') {
    const sinceMonday = (now.getDay() + 6) % 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
    for (let d = 0; d < 7; d++) {
      const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d);
      defs.push({ label: WEEKDAY_LABELS[d], start: startOfDay(day), end: startOfDay(day) + DAY_MS - 1 });
    }
  } else if (period === 'month') {
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const day = new Date(now.getFullYear(), now.getMonth(), d);
      defs.push({ label: `${d}`, start: startOfDay(day), end: startOfDay(day) + DAY_MS - 1 });
    }
  } else {
    if (lines.length === 0) return [];
    const first = lines.reduce(
      (min, line) => Math.min(min, new Date(line.createdAt).getTime()),
      Number.MAX_SAFE_INTEGER
    );
    const firstDate = new Date(first);
    let cursor = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    while (cursor.getTime() <= lastMonth) {
      const start = cursor.getTime();
      const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      defs.push({
        label: `${MONTH_LABELS[cursor.getMonth()]} ${String(cursor.getFullYear()).slice(2)}`,
        start,
        end: next.getTime() - 1,
      });
      cursor = next;
    }
  }

  return defs.map(({ label, start, end }) => {
    const orderIds = new Set<string>();
    let revenue = 0;
    for (const line of lines) {
      const t = new Date(line.createdAt).getTime();
      if (t < start || t > end) continue;
      orderIds.add(line.orderId);
      revenue += line.lineTotal;
    }
    return { label, orders: orderIds.size, revenue };
  });
}

export interface ProductRank {
  productId: string;
  label: string;
  units: number;
  revenue: number;
}

/** Every product with sales in the lines, ranked by units sold. Ties break
 *  alphabetically so the list doesn't jump between renders. */
export function rankProducts(lines: ReportLine[]): ProductRank[] {
  const byProduct = new Map<string, ProductRank>();
  for (const line of lines) {
    let entry = byProduct.get(line.productId);
    if (!entry) {
      entry = { productId: line.productId, label: line.productLabel, units: 0, revenue: 0 };
      byProduct.set(line.productId, entry);
    }
    entry.units += line.quantity;
    entry.revenue += line.lineTotal;
  }
  return [...byProduct.values()].sort(
    (a, b) => b.units - a.units || a.label.localeCompare(b.label)
  );
}

/** Item counts per status, every status present (0 when none). */
export function countByStatus(lines: ReportLine[]): Record<OrderStatus, number> {
  const counts = Object.fromEntries(ALL_ORDER_STATUSES.map((s) => [s, 0])) as Record<
    OrderStatus,
    number
  >;
  for (const line of lines) {
    counts[line.status] = (counts[line.status] ?? 0) + 1;
  }
  return counts;
}

export interface LocationGroup {
  label: string;
  orders: number;
  units: number;
}

/** Orders grouped by delivery location. The field is free text, so grouping
 *  normalizes case/whitespace and keeps the first-seen spelling for display;
 *  empty locations land in "Not specified". */
export function groupByLocation(lines: ReportLine[]): LocationGroup[] {
  const byKey = new Map<string, { label: string; orderIds: Set<string>; units: number }>();
  for (const line of lines) {
    const raw = line.location.trim().replace(/\s+/g, ' ');
    const key = raw.toLowerCase() || '(none)';
    let entry = byKey.get(key);
    if (!entry) {
      entry = { label: raw || 'Not specified', orderIds: new Set(), units: 0 };
      byKey.set(key, entry);
    }
    entry.orderIds.add(line.orderId);
    entry.units += line.quantity;
  }
  return [...byKey.values()]
    .map(({ label, orderIds, units }) => ({ label, orders: orderIds.size, units }))
    .sort((a, b) => b.orders - a.orders || a.label.localeCompare(b.label));
}

/** Distinct orders per weekday (Mon–Sun) and per hour (0–23), local time. */
export function ordersByWeekday(lines: ReportLine[]): number[] {
  const counts = new Array<number>(7).fill(0);
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.orderId)) continue;
    seen.add(line.orderId);
    const day = new Date(line.createdAt).getDay();
    counts[(day + 6) % 7] += 1;
  }
  return counts;
}

export function ordersByHour(lines: ReportLine[]): number[] {
  const counts = new Array<number>(24).fill(0);
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.orderId)) continue;
    seen.add(line.orderId);
    counts[new Date(line.createdAt).getHours()] += 1;
  }
  return counts;
}

export interface RepeatRate {
  /** Customers with 2+ distinct orders ÷ all customers, 0–100. */
  rate: number;
  repeatCustomers: number;
  totalCustomers: number;
}

export function repeatRate(lines: ReportLine[]): RepeatRate {
  const orderCounts = new Map<string, Set<string>>();
  for (const line of lines) {
    let orderIds = orderCounts.get(line.phone);
    if (!orderIds) {
      orderIds = new Set();
      orderCounts.set(line.phone, orderIds);
    }
    orderIds.add(line.orderId);
  }
  const total = orderCounts.size;
  const repeat = [...orderCounts.values()].filter((ids) => ids.size >= 2).length;
  return {
    rate: total === 0 ? 0 : Math.round((repeat / total) * 100),
    repeatCustomers: repeat,
    totalCustomers: total,
  };
}

export interface MonthlyRepeatRate {
  label: string;
  /** Repeat share among the month's customers: fraction whose cumulative
   *  order count by month-end reached 2+, 0–100. Null when the month had no
   *  customers at all. */
  rate: number | null;
  customers: number;
}

/** Repeat-rate trend for the last `months` calendar months (oldest first). */
export function monthlyRepeatRates(
  lines: ReportLine[],
  months = 6,
  now: Date = new Date()
): MonthlyRepeatRate[] {
  // Per phone: sorted order timestamps (an order counts once per phone).
  const byPhone = new Map<string, number[]>();
  const seenOrder = new Set<string>();
  for (const line of lines) {
    const key = `${line.phone}:${line.orderId}`;
    if (seenOrder.has(key)) continue;
    seenOrder.add(key);
    let times = byPhone.get(line.phone);
    if (!times) {
      times = [];
      byPhone.set(line.phone, times);
    }
    times.push(new Date(line.createdAt).getTime());
  }
  for (const times of byPhone.values()) times.sort((a, b) => a - b);

  const result: MonthlyRepeatRate[] = [];
  const firstMonth = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  for (let i = 0; i < months; i++) {
    const monthStart = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + i, 1).getTime();
    const monthEnd = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + i + 1, 1).getTime() - 1;
    let customers = 0;
    let repeat = 0;
    for (const times of byPhone.values()) {
      const inMonth = times.some((t) => t >= monthStart && t <= monthEnd);
      if (!inMonth) continue;
      customers += 1;
      if (times.filter((t) => t <= monthEnd).length >= 2) repeat += 1;
    }
    result.push({
      label: MONTH_LABELS[new Date(monthStart).getMonth()],
      rate: customers === 0 ? null : Math.round((repeat / customers) * 100),
      customers,
    });
  }
  return result;
}
