import { StyleSheet, Text } from 'react-native';
import { useApp } from '../context/AppContext';
import { useThemeColors, spacing, fontSizes, borderRadius } from '../constants/theme';
import { ORDER_STATUS_LABELS } from '../constants/orderStatus';
import { OrderStatus } from '../types';

interface OrderStatusBadgeProps {
  status: OrderStatus;
  small?: boolean;
}

/**
 * The single status badge for every order surface (shopper orders, order
 * detail, admin order lists). Toned backgrounds with colored text stay
 * readable in both themes — replaces the four copy-pasted badge style blocks
 * (which dropped `received`/`cancelled` and used white-on-yellow pending).
 */
export function OrderStatusBadge({ status, small = false }: OrderStatusBadgeProps) {
  const colors = useThemeColors();
  const { theme } = useApp();
  const dark = theme === 'dark';

  const palette: Record<OrderStatus, { bg: string; fg: string }> = {
    pending: { bg: colors.warning + '2E', fg: dark ? colors.warning : '#8A6D03' },
    received: { bg: colors.primary + '1A', fg: colors.primary },
    paid: { bg: '#0F766E1F', fg: dark ? '#2DD4BF' : '#0F766E' },
    on_the_way: { bg: '#0B5ED71A', fg: dark ? '#6EA8FE' : '#0B5ED7' },
    completed: { bg: colors.success + '1F', fg: dark ? colors.success : '#1E7E34' },
    cancelled: { bg: colors.danger + '1A', fg: colors.danger },
  };
  const tone = palette[status] ?? { bg: colors.border, fg: colors.textSecondary };

  return (
    <Text
      style={[
        styles.badge,
        small && styles.badgeSmall,
        { backgroundColor: tone.bg, color: tone.fg },
      ]}
    >
      {ORDER_STATUS_LABELS[status] ?? status}
    </Text>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.xl,
    fontSize: fontSizes.sm,
    fontWeight: '600',
    overflow: 'hidden',
  },
  badgeSmall: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    fontSize: fontSizes.xs,
  },
});
