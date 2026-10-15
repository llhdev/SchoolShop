import { StyleSheet, Text, View } from 'react-native';
import { VerificationStatus } from '../types';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  pending: 'Checking…',
  verified: 'Verified',
  needs_review: 'Needs review',
  failed: 'Payment failed checks',
  error: 'Verification error',
};

/** Small status chip for a merchant's verify.et payment verification. */
export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  return (
    <View
      style={[
        styles.badge,
        status === 'verified' && { backgroundColor: colors.success },
        status === 'needs_review' && { backgroundColor: colors.warning },
        (status === 'failed' || status === 'error') && { backgroundColor: colors.danger },
        status === 'pending' && styles.pendingBadge,
      ]}
    >
      <Text style={[styles.text, status === 'pending' && { color: colors.textSecondary }]}>
        {VERIFICATION_STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    badge: {
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: borderRadius.xl,
      backgroundColor: colors.border,
    },
    pendingBadge: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    text: {
      fontSize: fontSizes.xs,
      fontWeight: '600',
      color: colors.surface,
    },
  });
