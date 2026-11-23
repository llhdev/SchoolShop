import { supabase } from '../lib/supabase';
import { OrderStatus } from '../types';

/** Period summary from the get_scoped_order_stats RPC (migration 071).
 *  revenue is NULL for money-blind callers (stripped server-side). */
export interface ReportSummary {
  units: number;
  /** DISTINCT orders in the period. */
  orders: number;
  revenue: number | null;
  /** DISTINCT customer phones in the period. */
  customers: number;
  /** Phones with 2+ distinct orders in the period (repeat-rate numerator). */
  repeatCustomers: number;
}

/** Comparison-period summary; every field null when no previous period was
 *  requested (All time). */
export interface ReportPrevious {
  units: number | null;
  orders: number | null;
  revenue: number | null;
  customers: number | null;
}

export interface ReportProductRank {
  productId: string;
  label: string;
  units: number;
  revenue: number | null;
}

export interface ReportMonthlyRepeat {
  label: string;
  /** 0–100, null when the month had no customers. */
  rate: number | null;
  customers: number;
}

export interface ReportLocationGroup {
  label: string;
  orders: number;
  units: number;
}

export interface ReportTrendBucket {
  label: string;
  orders: number;
  revenue: number | null;
}

export interface ReportStats {
  current: ReportSummary;
  previous: ReportPrevious;
  productRanks: ReportProductRank[];
  hotWeek: ReportProductRank[];
  hotMonth: ReportProductRank[];
  /** Lines per effective status over ALL TIME (current state / to-do list). */
  statusCounts: Record<OrderStatus, number>;
  /** DISTINCT orders per weekday (Mon..Sun) / hour (0..23), all time. */
  weekdayCounts: number[];
  hourCounts: number[];
  monthlyRepeat: ReportMonthlyRepeat[];
  locations: ReportLocationGroup[];
  trend: ReportTrendBucket[];
}

export interface ReportStatsQuery {
  /** Super admin only: one shop (NULL = all shops). Ignored for staff. */
  tenantId?: string | null;
  /** ISO bounds of the selected period (NULL/NULL = all time). */
  from?: string | null;
  to?: string | null;
  /** ISO bounds of the comparison period (NULL = no deltas). */
  prevFrom?: string | null;
  prevTo?: string | null;
  /** new Date().getTimezoneOffset() of the client — all day/week/hour/month
   *  bucketing happens in this local time. */
  tzOffsetMinutes?: number;
  trendMode?: 'today' | 'week' | 'month' | 'all' | 'custom';
}

interface DbReportProductRank {
  product_id: string;
  label: string;
  units: number;
  revenue: number | null;
}

interface DbReportStats {
  current: {
    units: number;
    orders: number;
    revenue: number | null;
    customers: number;
    repeat_customers: number;
  };
  previous: {
    units: number | null;
    orders: number | null;
    revenue: number | null;
    customers: number | null;
  };
  product_ranks: DbReportProductRank[] | null;
  hot_week: DbReportProductRank[] | null;
  hot_month: DbReportProductRank[] | null;
  status_counts: Record<string, number> | null;
  weekday_counts: number[] | null;
  hour_counts: number[] | null;
  monthly_repeat: { label: string; rate: number | null; customers: number }[] | null;
  locations: { label: string; orders: number; units: number }[] | null;
  trend: { label: string; orders: number; revenue: number | null }[] | null;
}

function toProductRank(db: DbReportProductRank): ReportProductRank {
  return {
    productId: db.product_id,
    label: db.label,
    units: db.units,
    revenue: db.revenue,
  };
}

/** Admin Reports (migration 071): every report number, aggregated server-side
 *  over the same visible line set as get_scoped_order_lines (070). */
export async function fetchReportStats(query: ReportStatsQuery): Promise<ReportStats> {
  const { data, error } = await supabase.rpc('get_scoped_order_stats', {
    p_tenant_id: query.tenantId ?? null,
    p_from: query.from ?? null,
    p_to: query.to ?? null,
    p_prev_from: query.prevFrom ?? null,
    p_prev_to: query.prevTo ?? null,
    p_tz_offset_minutes: query.tzOffsetMinutes ?? 0,
    p_trend_mode: query.trendMode ?? 'month',
  });
  if (error) throw error;
  const payload = data as unknown as DbReportStats;
  return {
    current: {
      units: payload.current.units,
      orders: payload.current.orders,
      revenue: payload.current.revenue,
      customers: payload.current.customers,
      repeatCustomers: payload.current.repeat_customers ?? 0,
    },
    previous: payload.previous,
    productRanks: (payload.product_ranks ?? []).map(toProductRank),
    hotWeek: (payload.hot_week ?? []).map(toProductRank),
    hotMonth: (payload.hot_month ?? []).map(toProductRank),
    statusCounts: (payload.status_counts ?? {}) as Record<OrderStatus, number>,
    weekdayCounts: payload.weekday_counts ?? [],
    hourCounts: payload.hour_counts ?? [],
    monthlyRepeat: payload.monthly_repeat ?? [],
    locations: payload.locations ?? [],
    trend: payload.trend ?? [],
  };
}
