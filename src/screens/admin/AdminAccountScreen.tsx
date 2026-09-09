import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/Button';
import { AdminHeader } from '../../components/AdminHeader';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import {
  changeGateway,
  changePassword,
  fetchOwnProfile,
} from '../../services/account';
import {
  useThemeColors,
  spacing,
  borderRadius,
  fontSizes,
  ColorPalette,
} from '../../constants/theme';

const MAX_WIDTH = 640;

export function AdminAccountScreen() {
  const { role } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [profile, setProfile] = useState<{
    username: string | null;
    shopName: string | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [gateway, setGateway] = useState('');
  const [gatewayMessage, setGatewayMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [gatewayBusy, setGatewayBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  useEffect(() => {
    fetchOwnProfile()
      .then((own) => {
        setProfile(own ? { username: own.username, shopName: own.shopName } : null);
        setLoadError(own ? null : 'Could not load your account details.');
      })
      .catch(() => setLoadError('Could not load your account details.'));
  }, []);

  async function handleChangeGateway() {
    const clean = gateway.trim().toLowerCase();
    if (!clean) return;
    setGatewayBusy(true);
    setGatewayMessage(null);
    try {
      await changeGateway(clean);
      setProfile((p) => (p ? { ...p, username: clean } : p));
      setGateway('');
      setGatewayMessage({ kind: 'success', text: `Gateway changed to @${clean}.` });
    } catch (error) {
      setGatewayMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Failed to change gateway.',
      });
    } finally {
      setGatewayBusy(false);
    }
  }

  async function handleChangePassword() {
    setPasswordMessage(null);
    if (newPassword.length < 6) {
      setPasswordMessage({
        kind: 'error',
        text: 'New password must be at least 6 characters.',
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ kind: 'error', text: 'New passwords do not match.' });
      return;
    }
    setPasswordBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage({ kind: 'success', text: 'Password changed successfully.' });
    } catch (error) {
      setPasswordMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Failed to change password.',
      });
    } finally {
      setPasswordBusy(false);
    }
  }

  const isWeb = Platform.OS === 'web';

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen scroll noPadding edges={['left', 'right']}>
        <View style={styles.container}>
          <Text style={[styles.title, isPhone && styles.titleCompact]}>
            Account & Security
          </Text>
          {role === 'super_admin' && <Text style={styles.subtitle}>Super admin</Text>}
          {profile?.shopName && <Text style={styles.subtitle}>{profile.shopName}</Text>}
          <Text style={styles.gateway}>
            Current gateway: @{profile?.username ?? '—'}
          </Text>
          {loadError && <Text style={styles.errorText}>{loadError}</Text>}

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="key-outline" size={20} color={colors.primary} />
              <Text style={styles.cardTitle}>Change Gateway</Text>
            </View>
            <Text style={styles.cardHint}>
              This is the name you type in the search bar to sign in.
            </Text>
            <TextInput
              style={styles.input}
              value={gateway}
              onChangeText={setGateway}
              placeholder="New gateway"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {gatewayMessage && (
              <Text
                style={[
                  styles.feedback,
                  gatewayMessage.kind === 'success' ? styles.successText : styles.errorText,
                ]}
              >
                {gatewayMessage.text}
              </Text>
            )}
            <Button
              title="Change Gateway"
              onPress={handleChangeGateway}
              loading={gatewayBusy}
              disabled={gatewayBusy || !gateway.trim()}
            />
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.primary} />
              <Text style={styles.cardTitle}>Change Password</Text>
            </View>
            <TextInput
              style={styles.input}
              value={currentPassword}
              onChangeText={setCurrentPassword}
              placeholder="Current password"
              placeholderTextColor={colors.textSecondary}
              secureTextEntry
            />
            <TextInput
              style={styles.input}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="New password (min 6 characters)"
              placeholderTextColor={colors.textSecondary}
              secureTextEntry
            />
            <TextInput
              style={styles.input}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Confirm new password"
              placeholderTextColor={colors.textSecondary}
              secureTextEntry
            />
            {passwordMessage && (
              <Text
                style={[
                  styles.feedback,
                  passwordMessage.kind === 'success' ? styles.successText : styles.errorText,
                ]}
              >
                {passwordMessage.text}
              </Text>
            )}
            <Button
              title="Change Password"
              onPress={handleChangePassword}
              loading={passwordBusy}
              disabled={
                passwordBusy || !currentPassword || !newPassword || !confirmPassword
              }
            />
          </View>
        </View>
      </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      maxWidth: MAX_WIDTH,
      width: '100%',
      alignSelf: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      paddingBottom: spacing.xxl,
    },
    title: {
      fontSize: fontSizes.xxl,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.xs,
    },
    titleCompact: {
      fontSize: fontSizes.xl,
    },
    subtitle: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      marginBottom: spacing.xs,
    },
    gateway: {
      fontSize: fontSizes.md,
      color: colors.text,
      fontWeight: '600',
      marginBottom: spacing.lg,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginBottom: spacing.lg,
      gap: spacing.sm,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    cardTitle: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.text,
    },
    cardHint: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    input: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSizes.md,
      color: colors.text,
      ...(Platform.OS === 'web'
        ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
        : {}),
    },
    feedback: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
    },
    successText: {
      fontSize: fontSizes.sm,
      color: colors.success,
      fontWeight: '600',
    },
    errorText: {
      fontSize: fontSizes.sm,
      color: colors.danger,
      fontWeight: '600',
    },
  });
