import { StyleSheet, Text, TouchableOpacity, ViewStyle } from 'react-native';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'outline';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  style?: ViewStyle;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  style,
}: ButtonProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  return (
    <TouchableOpacity
      style={[
        styles.button,
        styles[variant],
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      <Text style={[styles.text, styles[`${variant}Text`], disabled && styles.disabledText]}>
        {title}
      </Text>
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
