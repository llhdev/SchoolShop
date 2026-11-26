// "Where was I?" highlight for the orders lists: tapping an order row records
// its id here, and the list consumes it on focus. A module-level store covers
// every back path (header back, in-page back link, browser back, swipe) —
// gesture/browser back cannot carry navigation params, and both list screens
// stay mounted under native-stack so their scroll position and loaded pages
// are already preserved.

let lastViewedOrderId: string | null = null;

/** Called when a list row opens OrderDetail. */
export function markOrderViewed(orderId: string): void {
  lastViewedOrderId = orderId;
}

/** Reads and clears the recorded id — a highlight is consumed exactly once. */
export function consumeLastViewedOrder(): string | null {
  const id = lastViewedOrderId;
  lastViewedOrderId = null;
  return id;
}
