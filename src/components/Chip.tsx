import { Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors, spacing, fontSizes, borderRadius } from '../constants/theme';

interface ChipProps {
  label: string;
  active?: boolean;
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}

/** Pill filter chip — the one chip style for filters across the app. */
export function Chip({ label, active = false, onPress, icon }: ChipProps) {
  const colors = useThemeColors();

  return (
    <TouchableOpacity
      style={[
        styles.chip,
        {
          backgroundColor: active ? colors.primary : colors.surface,
          borderColor: active ? colors.primary : colors.border,
        },
        Platform.OS === 'web' && ({ cursor: 'pointer' } as any),
      ]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      {icon && (
        <Ionicons
          name={icon}
          size={14}
          color={active ? colors.surface : colors.textSecondary}
          style={styles.icon}
        />
      )}
      <Text
        style={[
          styles.label,
          { color: active ? colors.surface : colors.textSecondary },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
  },
  icon: {
    marginRight: spacing.xs,
  },
  label: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
  },
});
