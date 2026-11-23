/**
 * Period helpers for the admin Reports screen. All aggregation moved
 * server-side (get_scoped_order_stats, migration 071) — what remains here is
 * the local-time period math the client needs to build the RPC's from/to
 * parameters, plus the % delta helper.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type PeriodKey = 'today' | 'week' | 'month' | 'all' | 'custom';

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom range' },
];

/** Label for the comparison period ("vs yesterday" …); null for 'all'. */
export const PREVIOUS_PERIOD_LABELS: Record<PeriodKey, string | null> = {
  all: null,
  today: 'vs yesterday',
  week: 'vs last week',
  month: 'vs last month',
  custom: 'vs previous period',
};

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** [startMs, endMs] inclusive in local time; null = no date filtering.
 *  Weeks start on Monday. 'custom' passes its explicit range through. */
export function periodRange(
  key: PeriodKey,
  now: Date = new Date(),
  custom?: [number, number] | null
): [number, number] | null {
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
    case 'custom':
      return custom ?? null;
    default:
      return null;
  }
}

/** The equivalent period immediately before the current one (yesterday,
 *  last Mon–Sun week, last calendar month); null for 'all'. Custom ranges
 *  compare against the immediately-preceding window of equal length. */
export function previousPeriodRange(
  key: PeriodKey,
  now: Date = new Date(),
  custom?: [number, number] | null
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
    case 'custom': {
      if (!custom) return null;
      const length = custom[1] - custom[0] + 1;
      return [custom[0] - length, custom[0] - 1];
    }
    default:
      return null;
  }
}

/** Parse "YYYY-MM-DD" as local midnight (Date.parse would treat it as UTC). */
export function parseDateInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const time = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isNaN(time) ? null : time;
}

export interface CustomRangeResult {
  /** [startMs, endMs] inclusive when both inputs hold valid dates in order. */
  range: [number, number] | null;
  /** True when the input is complete but unusable (bad format, or from > to)
   *  — show the inline error and don't fetch. Incomplete input (one side
   *  empty) is neither valid nor an error: wait for the second date. */
  invalid: boolean;
}

/** Resolve the custom-range inputs. Unlike the Orders screen's range helper,
 *  a from > to pair is an error here, not a silent swap. */
export function customRange(start: string, end: string): CustomRangeResult {
  if (!start.trim() && !end.trim()) return { range: null, invalid: false };
  const s = parseDateInput(start);
  const e = parseDateInput(end);
  if (s === null || e === null) {
    // One side still empty → incomplete, wait; one side malformed → error.
    const incomplete =
      (!start.trim() && e !== null) || (!end.trim() && s !== null);
    return { range: null, invalid: !incomplete };
  }
  if (s > e) return { range: null, invalid: true };
  return { range: [s, e + DAY_MS - 1], invalid: false };
}

/** % change from previous to current; null when there is no meaningful base
 *  (previous 0 — a bare "new" beats an infinite percentage). */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
