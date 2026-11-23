import { supabase } from '../lib/supabase';
import { Order, OrderStatus, PaymentWarning } from '../types';
import { DbOrder, toOrder } from './orders';

/** One visible line item of an order, as returned by the
 *  get_scoped_order_lines RPC (migration 070): server-side tenant + branch
 *  scoping, money fields NULL for callers without the financial capability. */
export interface OrderLineRow {
  orderId: string;
  createdAt: string;
  /** Per-line key ("productId:selectedImageIndex[:Group=Option|…]") — the same
   *  key itemStatuses uses, computed server-side (038/067 expression). */
  itemKey: string;
  /** Product name with the variant label appended ("Name (Size 42)"). */
  productName: string;
  quantity: number;
  /** NULL when the viewer is money-blind (stripped server-side). */
  unitPrice: number | null;
  lineTotal: number | null;
  /** Effective per-line status (itemStatuses entry else order status). */
  lineStatus: OrderStatus;
  orderStatus: OrderStatus;
  phoneNumber: string;
  location: string;
  telegramFirstName: string | null;
  telegramLastName: string | null;
  telegramUsername: string | null;
  fieldAnswers: { label: string; value: string }[];
  branchId: string | null;
  branchName: string | null;
  paymentMethod: string;
  /** The tenant's own payment_warnings entry (056) — financial viewers only. */
  paymentWarning: PaymentWarning | null;
}

export interface OrderLinesPage {
  rows: OrderLineRow[];
  /** Visible line rows matching the filters across ALL pages. */
  totalCount: number;
  /** Sum of visible line totals across all pages; NULL when money-blind. */
  totalRevenue: number | null;
  hasMore: boolean;
}

export interface OrderLinesQuery {
  /** Super admin only: the picked shop. Ignored (forced to the caller's own
   *  shop) for staff. */
  tenantId?: string | null;
  /** Effective line status; 'needs_review' is financial-only. NULL = all. */
  status?: OrderStatus | 'needs_review' | null;
  /** ISO bounds on the order's created_at (inclusive). */
  from?: string | null;
  to?: string | null;
  search?: string | null;
  /** Keyset cursor: the (createdAt, orderId) tuple of the last order of the
   *  previous page — pages are by ORDER, lines of one order stay together. */
  afterCreatedAt?: string | null;
  afterId?: string | null;
  /** Orders per page (server clamps to 1–500). */
  limit?: number;
}

interface DbOrderLineRow {
  order_id: string;
  created_at: string;
  item_key: string;
  product_name: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  line_status: string;
  order_status: string;
  phone_number: string;
  location: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  telegram_username: string | null;
  field_answers: { label: string; value: string }[] | null;
  branch_id: string | null;
  branch_name: string | null;
  payment_method: string;
  payment_warning: PaymentWarning | null;
}

interface DbOrderLinesPage {
  rows: DbOrderLineRow[] | null;
  total_count: number;
  total_revenue: number | null;
  has_more: boolean;
}

function toOrderLineRow(db: DbOrderLineRow): OrderLineRow {
  return {
    orderId: db.order_id,
    createdAt: db.created_at,
    itemKey: db.item_key,
    productName: db.product_name,
    quantity: db.quantity,
    unitPrice: db.unit_price,
    lineTotal: db.line_total,
    lineStatus: db.line_status as OrderStatus,
    orderStatus: db.order_status as OrderStatus,
    phoneNumber: db.phone_number,
    location: db.location ?? '',
    telegramFirstName: db.telegram_first_name,
    telegramLastName: db.telegram_last_name,
    telegramUsername: db.telegram_username,
    fieldAnswers: db.field_answers ?? [],
    branchId: db.branch_id,
    branchName: db.branch_name,
    paymentMethod: db.payment_method,
    paymentWarning: db.payment_warning,
  };
}

/** Merged admin orders page (migration 070): one page of visible line rows,
 *  filtered/searched/paginated server-side so it covers the whole history. */
export async function fetchScopedOrderLines(query: OrderLinesQuery): Promise<OrderLinesPage> {
  const { data, error } = await supabase.rpc('get_scoped_order_lines', {
    p_tenant_id: query.tenantId ?? null,
    p_status: query.status ?? null,
    p_from: query.from ?? null,
    p_to: query.to ?? null,
    p_search: query.search ?? null,
    p_after_created_at: query.afterCreatedAt ?? null,
    p_after_id: query.afterId ?? null,
    p_limit: query.limit ?? 100,
  });
  if (error) throw error;
  const payload = data as unknown as DbOrderLinesPage;
  return {
    rows: (payload.rows ?? []).map(toOrderLineRow),
    totalCount: payload.total_count ?? 0,
    totalRevenue: payload.total_revenue ?? null,
    hasMore: !!payload.has_more,
  };
}

/** One order for staff WITHOUT the financial capability (get_scoped_order
 *  RPC, migration 070) — the same money strip + branch scoping as
 *  get_scoped_orders (064). NULL when the order isn't visible to the caller.
 *  Super admin / financial staff read the table directly (fetchOrderById). */
export async function fetchScopedOrder(orderId: string): Promise<Order | null> {
  const { data, error } = await supabase.rpc('get_scoped_order', {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data ? toOrder(data as unknown as DbOrder) : null;
}
