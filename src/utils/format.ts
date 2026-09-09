const etbFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

/** Format a price in Ethiopian Birr (no cents — ETB is not decimal-priced here). */
export function formatPrice(price: number): string {
  return `${etbFormatter.format(price)} ETB`;
}

/**
 * Discount percentage for a sale price vs its compare-at price, or null when
 * there is no meaningful discount.
 */
export function getDiscountPercent(price: number, compareAtPrice?: number): number | null {
  if (!compareAtPrice || compareAtPrice <= price) return null;
  return Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
}
