import { CartItem, Product, VariantGroup } from '../types';

/** Stable string identifying one variant selection within a product
 *  ("Size=42-43|Color=Black"). Empty when the item has no selected options. */
export function variantKeyOf(item: Pick<CartItem, 'selectedOptions'>): string {
  return (item.selectedOptions ?? [])
    .map((o) => `${o.group}=${o.option}`)
    .join('|');
}

/** Unique id of one cart/order line: product + image + variant selection.
 *  Lines without options keep the legacy "productId:selectedImageIndex"
 *  format, so orders written before variants existed keep working (their
 *  itemStatuses keys still match). */
export function getCartItemLineId(
  item: Pick<CartItem, 'product' | 'selectedImageIndex' | 'selectedOptions'>
): string {
  const base = `${item.product.id}:${item.selectedImageIndex}`;
  const variantKey = variantKeyOf(item);
  return variantKey ? `${base}:${variantKey}` : base;
}

/** Unit price of a cart/order line: the variant price snapshotted at
 *  add-to-cart time, falling back to the product's base price. */
export function getUnitPrice(
  item: Pick<CartItem, 'product' | 'unitPrice'>
): number {
  return item.unitPrice ?? item.product.price;
}

/** Short human label for a selection ("Size 42-43 · Color Black"), '' when none. */
export function formatVariantLabel(
  item: Pick<CartItem, 'selectedOptions'>
): string {
  return (item.selectedOptions ?? [])
    .map((o) => `${o.group} ${o.option}`)
    .join(' · ');
}

/** Price for the current selection: the selected option of the price group,
 *  falling back to the product's base price. */
export function resolveVariantPrice(
  product: Product,
  selected: Record<string, string>
): number {
  const priceGroup = (product.variantGroups ?? []).find((g) => g.affectsPrice);
  if (!priceGroup) return product.price;
  const chosen = selected[priceGroup.name];
  const option = priceGroup.options.find((o) => o.name === chosen);
  return option?.price ?? product.price;
}

/** True while at least one group has no selection yet. */
export function hasUnselectedGroups(
  product: Product,
  selected: Record<string, string>
): boolean {
  return (product.variantGroups ?? []).some((g) => !selected[g.name]);
}

// --- DB (snake_case jsonb) ⇄ app (camelCase) mapping ---------------------

interface DbVariantOption {
  name?: unknown;
  price?: unknown;
  image_index?: unknown;
}

interface DbVariantGroup {
  name?: unknown;
  affects_price?: unknown;
  options?: unknown;
}

/** Parse the products.variants jsonb column, skipping malformed entries. */
export function toVariantGroups(raw: unknown): VariantGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const groups: VariantGroup[] = [];
  for (const g of raw as DbVariantGroup[]) {
    if (!g || typeof g.name !== 'string' || !g.name) continue;
    const options = Array.isArray(g.options) ? g.options : [];
    groups.push({
      name: g.name,
      affectsPrice: g.affects_price === true,
      options: (options as DbVariantOption[])
        .filter((o) => o && typeof o.name === 'string' && o.name)
        .map((o) => ({
          name: o.name as string,
          price: typeof o.price === 'number' ? o.price : undefined,
          imageIndex: typeof o.image_index === 'number' ? o.image_index : undefined,
        })),
    });
  }
  return groups.length > 0 ? groups : undefined;
}

/** Serialize variant groups for the products.variants jsonb column. */
export function toDbVariantGroups(
  groups: VariantGroup[] | undefined
): DbVariantGroup[] | null {
  if (!groups || groups.length === 0) return null;
  return groups.map((g) => ({
    name: g.name,
    affects_price: g.affectsPrice,
    options: g.options.map((o) => ({
      name: o.name,
      price: o.price ?? null,
      image_index: o.imageIndex ?? null,
    })),
  }));
}
