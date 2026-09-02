const etbFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

/** Format a price in Ethiopian Birr (no cents — ETB is not decimal-priced here). */
export function formatPrice(price: number): string {
  return `${etbFormatter.format(price)} ETB`;
}
