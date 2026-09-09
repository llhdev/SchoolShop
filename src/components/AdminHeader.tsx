import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../context/AppContext';
import { ThemeToggle } from './ThemeToggle';
import { AdminStackParamList } from '../types/navigation';
import { useResponsive } from '../hooks/useResponsive';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

type AdminNav = NativeStackNavigationProp<AdminStackParamList>;

interface NavLinkProps {
  name: keyof AdminStackParamList;
  label: string;
  current: string;
  compact?: boolean;
  onPress: () => void;
}

function NavLink({ name, label, current, onPress, compact }: NavLinkProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const active = current === name;
  return (
    <TouchableOpacity onPress={onPress} style={styles.navLink}>
      <Text style={[styles.navLinkText, compact && styles.navLinkTextCompact, active && styles.navLinkTextActive]}>
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
  const { signOutAdmin, role } = useApp();
  const { isDesktop } = useResponsive();
  const current = route.name;
  const isSuperAdmin = role === 'super_admin';
  const compact = !isDesktop;

  if (Platform.OS !== 'web') return null;

  return (
    <View style={[styles.header, compact && styles.headerCompact]}>
      <View style={[styles.inner, compact && styles.innerCompact]}>
        <View style={styles.brandRow}>
          <Ionicons name="settings-outline" size={compact ? 18 : 24} color={colors.primary} />
          <Text style={[styles.brandText, compact && styles.brandTextCompact]}>Admin Dashboard</Text>
        </View>

        <View style={[styles.nav, compact && styles.navCompact]}>
          <NavLink
            name="AdminDashboard"
            label="Dashboard"
            current={current}
            compact={compact}
            onPress={() => navigation.navigate('AdminDashboard')}
          />
          <NavLink
            name="AdminOrders"
            label="Orders"
            current={current}
            compact={compact}
            onPress={() => navigation.navigate('AdminOrders')}
          />
          <NavLink
            name="AdminAccount"
            label="Account"
            current={current}
            compact={compact}
            onPress={() => navigation.navigate('AdminAccount')}
          />
          <NavLink
            name="AddEditItem"
            label="Add Item"
            current={current}
            compact={compact}
            onPress={() => navigation.navigate('AddEditItem')}
          />
          {isSuperAdmin && (
            <NavLink
              name="TenantManagement"
              label="Tenants"
              current={current}
              compact={compact}
              onPress={() => navigation.navigate('TenantManagement')}
            />
          )}
        </View>

        <ThemeToggle />

        <TouchableOpacity style={[styles.exitButton, compact && styles.exitButtonCompact]} onPress={signOutAdmin}>
          <Text style={[styles.exitText, compact && styles.exitTextCompact]}>Exit admin</Text>
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
  headerCompact: {
    paddingVertical: spacing.sm,
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
  // Phone widths: let the row wrap so every control stays visible without
  // sideways scrolling — brand + toggle + exit on the first line, nav links
  // wrap onto the next.
  innerCompact: {
    flexWrap: 'wrap',
    rowGap: spacing.xs,
    columnGap: spacing.sm,
    paddingHorizontal: spacing.md,
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
  brandTextCompact: {
    fontSize: fontSizes.md,
  },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
  },
  navCompact: {
    gap: spacing.md,
    // `order` is web-only CSS (RNW passes it through); it puts the nav links
    // on their own line below brand/toggle/exit when the header wraps.
    ...({ order: 3, width: '100%' } as any),
    justifyContent: 'flex-start',
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
  navLinkTextCompact: {
    fontSize: fontSizes.sm,
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
  exitButtonCompact: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  exitText: {
    color: colors.danger,
    fontSize: fontSizes.sm,
    fontWeight: '600',
  },
  exitTextCompact: {
    fontSize: fontSizes.xs,
  },
});
