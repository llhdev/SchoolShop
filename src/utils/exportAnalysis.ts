import { Platform } from 'react-native';
import { ORDER_STATUS_LABELS } from '../constants/orderStatus';
import { OrderLineRow } from '../services/orderLines';
import { formatPrice } from './format';

/** Display name from the shopper columns the RPC joins from the public-read
 *  shoppers table: full name, else @username, else a dash. */
function telegramName(row: OrderLineRow): string {
  const full = [row.telegramFirstName, row.telegramLastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  return row.telegramUsername ? `@${row.telegramUsername}` : '—';
}

/**
 * Merge question labels that differ only by separators/casing
 * ("Grade Section", "Grade & Section", "Grade - Section") into one column.
 * Shared by the merged orders screen (column derivation) and this exporter.
 */
export function canonicalQuestionLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[&-]+/g, ' ').replace(/\s+/g, ' ');
}

/** First non-empty answer per canonical label for one line row. */
export function canonicalAnswers(row: OrderLineRow): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const answer of row.fieldAnswers) {
    const key = canonicalQuestionLabel(answer.label);
    if (!answers[key] && answer.value.trim()) answers[key] = answer.value.trim();
  }
  return answers;
}

/**
 * Web-only: build an .xlsx from the scoped order-line rows (same column order
 * and values as the on-screen merged orders table) and trigger a browser
 * download. The caller fetches the rows from get_scoped_order_lines in chunks
 * matching the current filters — this helper never touches context state.
 * `xlsx` is imported lazily so it never lands in native bundles (installed
 * from the SheetJS CDN tarball, not npm — the npm registry version is
 * unmaintained and carries known CVEs).
 * Money columns are included only for financial-capable viewers (`canSeeMoney`);
 * the Branch column appears only when at least one row has a branch.
 */
export async function downloadOrderLinesExcel(
  rows: OrderLineRow[],
  questionLabels: string[],
  questionDisplay: Map<string, string>,
  canSeeMoney: boolean,
  hasBranches: boolean
): Promise<void> {
  if (Platform.OS !== 'web' || rows.length === 0) return;

  const XLSX = await import('xlsx');

  const header = [
    'Order #',
    'Date & time',
    'Phone',
    'Telegram Name',
    'Product',
    'Quantity',
    ...(canSeeMoney ? ['Unit price', 'Line total'] : []),
    'Status',
    ...(hasBranches ? ['Branch'] : []),
    ...questionLabels.map((label) => questionDisplay.get(label) ?? label),
    'Location',
  ];
  const data = rows.map((row) => {
    const answers = canonicalAnswers(row);
    return [
      row.orderId,
      new Date(row.createdAt).toLocaleString(),
      row.phoneNumber,
      telegramName(row),
      row.productName,
      row.quantity,
      ...(canSeeMoney
        ? [
            row.unitPrice != null ? formatPrice(row.unitPrice) : '—',
            row.lineTotal != null ? formatPrice(row.lineTotal) : '—',
          ]
        : []),
      ORDER_STATUS_LABELS[row.lineStatus] ?? row.lineStatus,
      ...(hasBranches ? [row.branchName || '—'] : []),
      ...questionLabels.map((label) => answers[label] ?? '—'),
      row.location || '—',
    ];
  });

  const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Orders');
  const buffer = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `orders-${date}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
