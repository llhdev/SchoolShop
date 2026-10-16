import { Platform } from 'react-native';
import { ORDER_STATUS_LABELS } from '../constants/orderStatus';
import { AnalysisRow } from '../screens/admin/AdminAnalysisScreen';

/**
 * Web-only: build an .xlsx from the analysis rows (same column order and values
 * as the on-screen table) and trigger a browser download.
 * `xlsx` is imported lazily so it never lands in native bundles.
 */
export async function downloadAnalysisExcel(
  rows: AnalysisRow[],
  questionLabels: string[],
  questionDisplay: Map<string, string>,
  telegramNameFor: (row: AnalysisRow) => string
): Promise<void> {
  if (Platform.OS !== 'web' || rows.length === 0) return;

  const XLSX = await import('xlsx');

  const header = [
    'Order #',
    'Date & time',
    'Phone',
    'Telegram Name',
    'Student name',
    'Product',
    'Quantity',
    'Status',
    ...questionLabels.map((label) => questionDisplay.get(label) ?? label),
    'Location',
  ];
  const data = rows.map((row) => [
    row.orderId,
    new Date(row.createdAt).toLocaleString(),
    row.phoneNumber,
    telegramNameFor(row),
    row.studentName || '—',
    row.productLabel,
    row.quantity,
    ORDER_STATUS_LABELS[row.status],
    ...questionLabels.map((label) => row.answers[label] ?? '—'),
    row.location || '—',
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Shopper Analysis');
  const buffer = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `shopper-analysis-${date}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
