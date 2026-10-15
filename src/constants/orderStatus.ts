import { OrderStatus } from '../types';

/** The single order lifecycle, in flow order. Settable by the super admin
 *  and by tenant admins whose shop is part of the order (migration 020). */
export const ORDER_STATUSES: OrderStatus[] = ['pending', 'paid', 'on_the_way', 'completed'];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  paid: 'Order Received',
  on_the_way: 'Shipped',
  completed: 'Completed',
};
