import { StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useResponsive } from '../hooks/useResponsive';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search items...',
}: SearchBarProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { isPhone } = useResponsive();

  return (
    <View style={[styles.container, isPhone && styles.containerCompact]}>
      <Ionicons
        name="search-outline"
        size={isPhone ? 14 : 18}
        color={colors.textSecondary}
      />
      <TextInput
        style={[styles.input, isPhone && styles.inputCompact]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
      />
      {value.length > 0 && (
        <Ionicons
          name="close-circle"
          size={isPhone ? 14 : 18}
          color={colors.textSecondary}
          onPress={() => onChangeText('')}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  containerCompact: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    gap: 2,
  },
  input: {
    flex: 1,
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  inputCompact: {
    fontSize: fontSizes.xs,
  },
});
