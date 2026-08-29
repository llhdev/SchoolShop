import { StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { useThemeColors } from '../constants/theme';

interface ThemeToggleProps {
  size?: number;
}

export function ThemeToggle({ size = 22 }: ThemeToggleProps) {
  const { theme, toggleTheme } = useApp();
  const colors = useThemeColors();

  return (
    <TouchableOpacity
      onPress={toggleTheme}
      style={styles.button}
      activeOpacity={0.7}
      accessibilityLabel={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <Ionicons
        name={theme === 'dark' ? 'sunny-outline' : 'moon-outline'}
        size={size}
        color={colors.primary}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    padding: 4,
  },
});
