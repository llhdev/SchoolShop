import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useThemeColors, spacing, fontSizes, borderRadius, ColorPalette } from '../constants/theme';

interface StatCardProps {
  value: string | number;
  label: string;
  /** Left accent bar (e.g. per-status hue on the orders summary cards). */
  accentColor?: string;
  style?: StyleProp<ViewStyle>;
}

/** The one summary stat card for admin dashboards — replaces the three
 *  divergent copies (Dashboard, Orders, Analysis). */
export function StatCard({ value, label, accentColor, style }: StatCardProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  return (
    <View
      style={[
        styles.card,
        accentColor ? { borderLeftWidth: 3, borderLeftColor: accentColor } : null,
        style,
      ]}
    >
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    card: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.sm,
      alignItems: 'center',
    },
    value: {
      fontSize: fontSizes.xl,
      fontWeight: '700',
      color: colors.primary,
    },
    label: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
  });
