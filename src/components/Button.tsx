import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'outline';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
}: ButtonProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  return (
    <TouchableOpacity
      style={[
        styles.button,
        styles[variant],
        (disabled || loading) && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
    >
      <View style={styles.content}>
        {loading && (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        )}
        <Text style={[styles.text, styles[`${variant}Text`], (disabled || loading) && styles.disabledText]}>
          {title}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    button: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      borderRadius: borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: 'transparent',
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    primary: {
      backgroundColor: colors.primary,
    },
    secondary: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
    },
    danger: {
      backgroundColor: colors.danger,
    },
    outline: {
      backgroundColor: colors.surface,
      borderColor: colors.primary,
    },
    disabled: {
      backgroundColor: colors.border,
      borderColor: colors.border,
    },
    text: {
      fontSize: fontSizes.md,
      fontWeight: '600',
    },
    primaryText: {
      color: colors.surface,
    },
    secondaryText: {
      color: colors.text,
    },
    dangerText: {
      color: colors.surface,
    },
    outlineText: {
      color: colors.primary,
    },
    disabledText: {
      color: colors.textSecondary,
    },
  });
