import { CartItem } from '../types';
import { ColorPalette, fontSizes, spacing } from '../constants/theme';

const WIDTH = 640;
const PADDING = spacing.xl;
const TITLE_SIZE = fontSizes.xxl;
const SUBTITLE_SIZE = fontSizes.sm;
const ITEM_SIZE = fontSizes.md;
const TOTAL_SIZE = fontSizes.xl;
const FOOTER_SIZE = fontSizes.sm;
const LINE_HEIGHT = 1.5;
const SECTION_GAP = spacing.md;
const ITEM_GAP = spacing.sm;

function getLineHeight(fontSize: number): number {
  return Math.round(fontSize * LINE_HEIGHT);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = words[0] || '';

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const testLine = `${currentLine} ${word}`;
    const metrics = ctx.measureText(testLine);
    if (metrics.width <= maxWidth) {
      currentLine = testLine;
    } else {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length >= maxLines - 1) break;
    }
  }

  lines.push(currentLine);
  return lines;
}

function truncateWithEllipsis(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  const metrics = ctx.measureText(text);
  if (metrics.width <= maxWidth) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidate = `${text.slice(0, mid)}...`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low)}...`;
}

export function createWebSummaryImage(
  cart: CartItem[],
  cartTotal: number,
  colors: ColorPalette
): string | null {
  if (typeof document === 'undefined') return null;

  const maxNameWidth = WIDTH - PADDING * 2 - 120; // reserve space for price

  // Calculate initial height with a scratch canvas.
  const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) return null;

  scratchCtx.font = `${ITEM_SIZE}px sans-serif`;

  let itemsHeight = 0;
  for (const item of cart) {
    const variantLabel =
      item.product.images.length > 1
        ? ` (Variant ${item.selectedImageIndex + 1})`
        : '';
    const name = `${item.quantity} × ${item.product.name}${variantLabel}`;
    const lines = wrapText(scratchCtx, name, maxNameWidth, 2);
    itemsHeight += lines.length * getLineHeight(ITEM_SIZE) + ITEM_GAP;
  }
  if (cart.length > 0) {
    itemsHeight -= ITEM_GAP; // remove trailing gap
  }

  const height =
    PADDING +
    getLineHeight(TITLE_SIZE) +
    getLineHeight(SUBTITLE_SIZE) +
    SECTION_GAP +
    1 + // first divider
    SECTION_GAP +
    itemsHeight +
    SECTION_GAP +
    1 + // second divider
    SECTION_GAP +
    getLineHeight(TOTAL_SIZE) +
    SECTION_GAP +
    getLineHeight(FOOTER_SIZE) +
    PADDING;

  // Create high-resolution canvas.
  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = WIDTH * scale;
  canvas.height = height * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(scale, scale);
  ctx.textBaseline = 'top';

  // Background.
  ctx.fillStyle = colors.surface;
  ctx.fillRect(0, 0, WIDTH, height);

  let y = PADDING;

  // Title.
  ctx.fillStyle = colors.text;
  ctx.font = `800 ${TITLE_SIZE}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('Order Summary', WIDTH / 2, y);
  y += getLineHeight(TITLE_SIZE);

  // Date.
  ctx.fillStyle = colors.textSecondary;
  ctx.font = `${SUBTITLE_SIZE}px sans-serif`;
  ctx.fillText(new Date().toLocaleDateString(), WIDTH / 2, y);
  y += getLineHeight(SUBTITLE_SIZE) + SECTION_GAP;

  // First divider.
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, y + 0.5);
  ctx.lineTo(WIDTH - PADDING, y + 0.5);
  ctx.stroke();
  y += 1 + SECTION_GAP;

  // Items.
  ctx.font = `${ITEM_SIZE}px sans-serif`;
  for (const item of cart) {
    const variantLabel =
      item.product.images.length > 1
        ? ` (Variant ${item.selectedImageIndex + 1})`
        : '';
    const name = `${item.quantity} × ${item.product.name}${variantLabel}`;
    const price = `$${(item.product.price * item.quantity).toFixed(2)}`;

    const lines = wrapText(ctx, name, maxNameWidth, 2);
    const blockHeight = lines.length * getLineHeight(ITEM_SIZE);

    ctx.fillStyle = colors.text;
    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const displayLine =
        i === lines.length - 1
          ? truncateWithEllipsis(ctx, line, maxNameWidth)
          : line;
      ctx.fillText(displayLine, PADDING, y + i * getLineHeight(ITEM_SIZE));
    }

    ctx.textAlign = 'right';
    ctx.font = `700 ${ITEM_SIZE}px sans-serif`;
    ctx.fillText(price, WIDTH - PADDING, y);
    ctx.font = `${ITEM_SIZE}px sans-serif`;

    y += blockHeight + ITEM_GAP;
  }
  if (cart.length > 0) {
    y -= ITEM_GAP;
  }

  y += SECTION_GAP;

  // Second divider.
  ctx.strokeStyle = colors.border;
  ctx.beginPath();
  ctx.moveTo(PADDING, y + 0.5);
  ctx.lineTo(WIDTH - PADDING, y + 0.5);
  ctx.stroke();
  y += 1 + SECTION_GAP;

  // Total.
  ctx.fillStyle = colors.text;
  ctx.font = `800 ${TOTAL_SIZE}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText('Total', PADDING, y);
  ctx.fillStyle = colors.primary;
  ctx.textAlign = 'right';
  ctx.fillText(`$${cartTotal.toFixed(2)}`, WIDTH - PADDING, y);
  y += getLineHeight(TOTAL_SIZE) + SECTION_GAP;

  // Footer.
  ctx.fillStyle = colors.textSecondary;
  ctx.font = `${FOOTER_SIZE}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('Sent from OnlineShop', WIDTH / 2, y);

  return canvas.toDataURL('image/png');
}
