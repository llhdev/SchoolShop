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

/** "1.4 MB" style label for a downloadable file; empty when size is unknown. */
export function formatFileSize(sizeBytes?: number): string {
  if (!sizeBytes || sizeBytes <= 0) return '';
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}
