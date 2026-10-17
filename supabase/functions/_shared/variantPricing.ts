// Server-side port of the client's variant unit-price resolution
// (src/utils/variants.ts — resolveVariantPrice, reading the raw
// products.variants jsonb column instead of the mapped camelCase shape).
// Used by verify-payment-reference to recompute the expected amount from
// the database, never trusting client-sent prices. Dependency-free.

export interface SelectedOption {
  group: string;
  option: string;
}

interface DbVariantOption {
  name?: unknown;
  price?: unknown;
}

interface DbVariantGroup {
  name?: unknown;
  affects_price?: unknown;
  options?: unknown;
}

/** Unit price for one order line: the price of the chosen option in the
 *  price-affecting group (the FIRST group with affects_price = true, same
 *  as the client), falling back to the product's base price when there is
 *  no price group, the chosen option is unknown, or the option carries no
 *  price of its own. Malformed group/option entries are skipped like the
 *  client's toVariantGroups does. */
export function resolveUnitPrice(
  product: { price: number; variants?: unknown },
  selectedOptions: SelectedOption[]
): number {
  const groups = (Array.isArray(product.variants) ? product.variants : []) as DbVariantGroup[];
  const priceGroup = groups.find((g) => g && typeof g.name === 'string' && g.affects_price === true);
  if (!priceGroup) return product.price;
  const chosen = selectedOptions.find((o) => o.group === (priceGroup.name as string))?.option;
  const options = (Array.isArray(priceGroup.options) ? priceGroup.options : []) as DbVariantOption[];
  const option = options.find((o) => o && typeof o.name === 'string' && o.name === chosen);
  return typeof option?.price === 'number' ? option.price : product.price;
}
