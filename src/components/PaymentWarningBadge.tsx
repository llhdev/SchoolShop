import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PaymentWarning } from '../types';
import { useApp } from '../context/AppContext';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

export const PAYMENT_WARNING_LABELS: Record<PaymentWarning['reason'], string> = {
  unreadable: 'Receipt unreadable',
  not_found: 'Reference not found',
  unavailable: 'Verification unavailable',
};

/** Amber "check proof" chip for orders placed on a verification warning pass
 *  (migration 056) — the payment could not be confirmed, so staff should
 *  eyeball the proof before marking paid. */
export function PaymentWarningBadge({ reason }: { reason: PaymentWarning['reason'] }) {
  const colors = useThemeColors();
  const { theme } = useApp();
  const styles = makeStyles(colors);
  // Same toned-amber treatment as the needs-review verification badge.
  const fg = theme === 'dark' ? colors.warning : '#8A6D03';
  return (
    <View style={[styles.badge, { backgroundColor: colors.warning + '2E' }]}>
      <Ionicons name="warning-outline" size={12} color={fg} />
      <Text style={[styles.text, { color: fg }]}>{PAYMENT_WARNING_LABELS[reason]}</Text>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    badge: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: borderRadius.xl,
    },
    text: {
      fontSize: fontSizes.xs,
      fontWeight: '600',
    },
  });
