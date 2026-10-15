import { CheckoutField } from '../types';

/** Labels of required checkout questions that have no answer yet. */
export function missingRequiredAnswers(
  fields: CheckoutField[],
  answers: Record<string, string> | undefined
): string[] {
  return fields
    .filter((f) => f.required && !(answers?.[f.label] ?? '').trim())
    .map((f) => f.label);
}

// --- DB (snake_case jsonb) ⇄ app (camelCase) mapping ---------------------

interface DbCheckoutField {
  label?: unknown;
  type?: unknown;
  required?: unknown;
  options?: unknown;
}

/** Parse the products.checkout_fields jsonb column, skipping malformed entries. */
export function toCheckoutFields(raw: unknown): CheckoutField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const fields: CheckoutField[] = [];
  for (const f of raw as DbCheckoutField[]) {
    if (!f || typeof f.label !== 'string' || !f.label) continue;
    const type = f.type === 'dropdown' ? 'dropdown' : 'text';
    const options = Array.isArray(f.options)
      ? (f.options as unknown[]).filter(
          (o): o is string => typeof o === 'string' && o.length > 0
        )
      : [];
    fields.push({
      label: f.label,
      type,
      required: f.required === true,
      ...(type === 'dropdown' ? { options } : {}),
    });
  }
  return fields.length > 0 ? fields : undefined;
}

/** Serialize checkout questions for the products.checkout_fields jsonb column. */
export function toDbCheckoutFields(
  fields: CheckoutField[] | undefined
): DbCheckoutField[] | null {
  if (!fields || fields.length === 0) return null;
  return fields.map((f) => ({
    label: f.label,
    type: f.type,
    required: f.required,
    options: f.type === 'dropdown' ? (f.options ?? []) : null,
  }));
}
