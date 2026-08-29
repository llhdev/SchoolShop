import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../context/AppContext';
import { ThemeToggle } from './ThemeToggle';
import { AdminStackParamList } from '../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

type AdminNav = NativeStackNavigationProp<AdminStackParamList>;

interface NavLinkProps {
  name: keyof AdminStackParamList;
  label: string;
  current: string;
  onPress: () => void;
}

function NavLink({ name, label, current, onPress }: NavLinkProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const active = current === name;
  return (
    <TouchableOpacity onPress={onPress} style={styles.navLink}>
      <Text style={[styles.navLinkText, active && styles.navLinkTextActive]}>
        {label}
      </Text>
      {active && <View style={styles.activeIndicator} />}
    </TouchableOpacity>
  );
}

export function AdminHeader() {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const navigation = useNavigation<AdminNav>();
  const route = useRoute();
  const { signOutAdmin } = useApp();
  const current = route.name;

  if (Platform.OS !== 'web') return null;

  return (
    <View style={styles.header}>
      <View style={styles.inner}>
        <View style={styles.brandRow}>
          <Ionicons name="settings-outline" size={24} color={colors.primary} />
          <Text style={styles.brandText}>Admin Dashboard</Text>
        </View>

        <View style={styles.nav}>
          <NavLink
            name="AdminDashboard"
            label="Dashboard"
            current={current}
            onPress={() => navigation.navigate('AdminDashboard')}
          />
          <NavLink
            name="AdminOrders"
            label="Orders"
            current={current}
            onPress={() => navigation.navigate('AdminOrders')}
          />
          <NavLink
            name="AddEditItem"
            label="Add Item"
            current={current}
            onPress={() => navigation.navigate('AddEditItem')}
          />
        </View>

        <ThemeToggle />

        <TouchableOpacity style={styles.exitButton} onPress={signOutAdmin}>
          <Text style={styles.exitText}>Exit admin</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  header: {
    width: '100%',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.md,
    ...(Platform.OS === 'web'
      ? ({
          boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
        } as any)
      : {}),
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    maxWidth: 1200,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  brandText: {
    fontSize: fontSizes.xl,
    fontWeight: '800',
    color: colors.text,
  },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
  },
  navLink: {
    paddingVertical: spacing.sm,
    position: 'relative',
  },
  navLinkText: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  navLinkTextActive: {
    color: colors.primary,
  },
  activeIndicator: {
    position: 'absolute',
    bottom: -4,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.primary,
    borderRadius: 1,
  },
  exitButton: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  exitText: {
    color: colors.danger,
    fontSize: fontSizes.sm,
    fontWeight: '600',
  },
});
