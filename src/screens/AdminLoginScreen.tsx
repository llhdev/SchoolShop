import { useEffect, useState } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen } from '../components/Screen';
import { Button } from '../components/Button';
import { useApp } from '../context/AppContext';
import { supabase } from '../lib/supabase';
import { notify } from '../utils/notify';
import { RootStackParamList } from '../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

export function AdminLoginScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute();
  const { username, emails } = route.params as { username: string; emails: string[] };
  const { setRole, setStaffSession } = useApp();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Remaining lockout seconds; > 0 means the form is locked. */
  const [lockRemaining, setLockRemaining] = useState(0);
  const isLocked = lockRemaining > 0;

  const maxAttempts = 5;
  const lockoutSeconds = 30;

  // Count down the lockout one second at a time so the button shows the
  // remaining wait; reaching zero also reopens the attempt counter.
  useEffect(() => {
    if (lockRemaining <= 0) {
      if (attempts >= maxAttempts) setAttempts(0);
      return;
    }
    const timer = setTimeout(() => setLockRemaining((s) => s - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockRemaining]);

  async function handleLogin() {
    if (isLocked) return;

    if (!emails || emails.length === 0 || !password) {
      notify('Admin credentials are not set.', 'error');
      return;
    }

    // One gateway username fronts several accounts (owner + staff): try each
    // email with the typed password — the password picks the account.
    let data: { user: { id: string } | null } | null = null;
    for (const email of emails) {
      const attempt = await supabase.auth.signInWithPassword({ email, password });
      if (!attempt.error && attempt.data.user) {
        data = attempt.data;
        break;
      }
    }

    if (!data?.user) {
      const nextAttempts = attempts + 1;
      setAttempts(nextAttempts);

      if (nextAttempts >= maxAttempts) {
        setLockRemaining(lockoutSeconds);
        setError(null);
      } else {
        setError(`Incorrect password — ${maxAttempts - nextAttempts} attempts remaining.`);
      }

      setPassword('');
      return;
    }

    // Confirm the signed-in user is marked as admin or super admin.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select(
        'role, is_active, parent_tenant_id, staff_financial, staff_shop, staff_branch, branch_id, staff_label, branch_selection_enabled'
      )
      .eq('id', data.user.id)
      .single();

    const allowedRoles: string[] = ['admin', 'super_admin'];
    if (profileError || !allowedRoles.includes(profile?.role ?? '')) {
      await supabase.auth.signOut();
      notify('This account does not have admin privileges.', 'error');
      setPassword('');
      return;
    }

    // A shop switched off by the super admin logs nobody in — neither the
    // owner nor its staff (migration 037 + 045).
    let branchSelectionEnabled = true;
    if (profile!.role === 'admin') {
      let switchedOff = profile!.is_active === false;
      branchSelectionEnabled = profile!.branch_selection_enabled !== false;
      if (profile!.parent_tenant_id) {
        const { data: parent } = await supabase
          .from('profiles')
          .select('is_active, branch_selection_enabled')
          .eq('id', profile!.parent_tenant_id)
          .single();
        switchedOff = switchedOff || parent?.is_active === false;
        if (parent) branchSelectionEnabled = parent.branch_selection_enabled !== false;
      }
      if (switchedOff) {
        await supabase.auth.signOut();
        notify('This shop has been switched off. Please contact the administrator.', 'error');
        setPassword('');
        return;
      }
    }

    setPassword('');
    setAttempts(0);
    if (profile!.role === 'admin') {
      setStaffSession({
        tenantId: profile!.parent_tenant_id ?? data.user.id,
        capabilities: {
          financial: !!profile!.staff_financial,
          shop: !!profile!.staff_shop,
          branch: !!profile!.staff_branch,
        },
        branchId: profile!.branch_id ?? null,
        label: profile!.staff_label ?? null,
        branchSelectionEnabled,
      });
    } else {
      setStaffSession(null);
    }
    // Switching role lets AppNavigator render the admin stack automatically.
    setRole(profile!.role as 'admin' | 'super_admin');
  }

  return (
    <Screen centered style={styles.screenOverride}>
      <View style={styles.card}>
        <Ionicons
          name="lock-closed-outline"
          size={48}
          color={colors.primary}
          style={styles.icon}
        />
        <Text style={styles.title}>Admin Access</Text>
        <Text style={styles.subtitle}>
          Log in as @{username}
        </Text>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              setError(null);
            }}
            placeholder="Password"
            placeholderTextColor={colors.textSecondary}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isLocked}
          />
          <TouchableOpacity
            style={styles.eyeButton}
            onPress={() => setShowPassword((prev) => !prev)}
          >
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={colors.textSecondary}
            />
          </TouchableOpacity>
        </View>
        {error && <Text style={styles.errorText}>{error}</Text>}

        <Button
          title={isLocked ? `Try again in ${lockRemaining}s` : 'Login'}
          onPress={handleLogin}
          disabled={isLocked || password.length === 0}
          style={styles.button}
        />

        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.cancelButton}>
          <Text style={[styles.cancelText, { color: colors.textSecondary }]}>
            Cancel
          </Text>
        </TouchableOpacity>
      </View>
    </Screen>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    screenOverride: {
      justifyContent: 'flex-start',
      paddingTop: spacing.xxl,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.xl,
    },
    icon: {
      marginBottom: spacing.md,
    },
    title: {
      fontSize: fontSizes.xxl,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.sm,
    },
    subtitle: {
      fontSize: fontSizes.md,
      color: colors.textSecondary,
      textAlign: 'center',
      marginBottom: spacing.xxl,
    },
    inputContainer: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.md,
    },
    input: {
      flex: 1,
      paddingVertical: spacing.md,
      fontSize: fontSizes.md,
      color: colors.text,
      // Web draws a focus outline on the inner <input> that doubles the
      // container border — suppress it so the field reads as one box.
      ...(Platform.OS === 'web'
        ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
        : {}),
    },
    eyeButton: {
      padding: spacing.sm,
    },
    errorText: {
      alignSelf: 'flex-start',
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.danger,
      marginBottom: spacing.md,
    },
    button: {
      width: '100%',
    },
    cancelButton: {
      marginTop: spacing.md,
      padding: spacing.sm,
    },
    cancelText: {
      fontSize: fontSizes.md,
      fontWeight: '600',
    },
  });
