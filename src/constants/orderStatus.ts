import { OrderStatus } from '../types';

/** The forward order lifecycle, in flow order (migration 045):
 *  pending -> received (branch staff) -> paid (financial staff) ->
 *  on_the_way -> completed (branch staff). Cancelled is a terminal
 *  side-exit, kept out of the linear flow. */
export const ORDER_STATUSES: OrderStatus[] = ['pending', 'received', 'paid', 'on_the_way', 'completed'];

/** Terminal status set by branch staff from pending/received. */
export const CANCELLED_STATUS: OrderStatus = 'cancelled';

/** All statuses including cancelled — for filters and badges. */
export const ALL_ORDER_STATUSES: OrderStatus[] = [...ORDER_STATUSES, CANCELLED_STATUS];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  received: 'Order Received',
  paid: 'Paid',
  on_the_way: 'Shipped',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
