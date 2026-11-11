import { Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors, spacing, fontSizes, borderRadius } from '../constants/theme';

interface DashedUploadButtonProps {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}

/** Dashed-outline pick/upload affordance — replaces the five near-identical
 * hand-rolled copies (checkout proof picker, tenant logo/QR pickers, …). */
export function DashedUploadButton({ label, onPress, icon = 'cloud-upload-outline' }: DashedUploadButtonProps) {
  const colors = useThemeColors();

  return (
    <TouchableOpacity
      style={[
        styles.button,
        { borderColor: colors.primary },
        Platform.OS === 'web' && ({ cursor: 'pointer' } as any),
      ]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Ionicons name={icon} size={20} color={colors.primary} />
      <Text style={[styles.label, { color: colors.primary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  label: {
    fontSize: fontSizes.md,
    fontWeight: '600',
  },
});
