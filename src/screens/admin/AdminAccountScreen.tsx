import { useEffect, useState } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/Button';
import { AdminHeader } from '../../components/AdminHeader';
import { BankAccountsEditor } from '../../components/BankAccountsEditor';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import {
  changeGateway,
  changePassword,
  fetchOwnProfile,
  updateOwnBankAccounts,
  updateOwnShippingFee,
  updateOwnShopDescription,
  updateOwnTelegramUsername,
} from '../../services/account';
import {
  useThemeColors,
  spacing,
  borderRadius,
  fontSizes,
  ColorPalette,
} from '../../constants/theme';
import { MERCHANT_ACCOUNT_EDITING_ENABLED } from '../../constants/featureFlags';
import { BankAccount } from '../../types';

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

  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [bankMessage, setBankMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [bankBusy, setBankBusy] = useState(false);

  const [shippingFee, setShippingFee] = useState('');
  const [shippingMessage, setShippingMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [shippingBusy, setShippingBusy] = useState(false);

  const [shopDescription, setShopDescription] = useState('');
  const [descriptionMessage, setDescriptionMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [descriptionBusy, setDescriptionBusy] = useState(false);

  const [telegramUsername, setTelegramUsername] = useState('');
  const [telegramMessage, setTelegramMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [telegramBusy, setTelegramBusy] = useState(false);

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
        setBankAccounts(own?.bankAccounts ?? []);
        setShippingFee(own?.shippingFee ? String(Math.round(own.shippingFee)) : '');
        setShopDescription(own?.shopDescription ?? '');
        setTelegramUsername(own?.telegramUsername ?? '');
        setLoadError(own ? null : 'Could not load your account details.');
      })
      .catch(() => setLoadError('Could not load your account details.'));
  }, []);

  async function handleSaveBankDetails() {
    const accounts = bankAccounts.filter((a) => a.accountNumber.trim());
    if (accounts.length === 0) {
      setBankMessage({ kind: 'error', text: 'Add at least one account with an account number.' });
      return;
    }
    setBankBusy(true);
    setBankMessage(null);
    try {
      await updateOwnBankAccounts(accounts);
      setBankMessage({ kind: 'success', text: 'Bank transfer details saved.' });
    } catch (error) {
      setBankMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Failed to save bank details.',
      });
    } finally {
      setBankBusy(false);
    }
  }

  async function handleSaveShippingFee() {
    const trimmed = shippingFee.trim();
    const fee = trimmed === '' ? 0 : Number(trimmed);
    if (!Number.isFinite(fee) || fee < 0) {
      setShippingMessage({ kind: 'error', text: 'Enter a valid shipping fee in Birr.' });
      return;
    }
    setShippingBusy(true);
    setShippingMessage(null);
    try {
      await updateOwnShippingFee(fee > 0 ? fee : null);
      setShippingMessage({
        kind: 'success',
        text: fee > 0 ? 'Shipping fee saved.' : 'Shipping fee cleared — delivery is free.',
      });
    } catch (error) {
      setShippingMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Failed to save shipping fee.',
      });
    } finally {
      setShippingBusy(false);
    }
  }

  async function handleSaveDescription() {
    setDescriptionBusy(true);
    setDescriptionMessage(null);
    try {
      await updateOwnShopDescription(shopDescription);
      setDescriptionMessage({ kind: 'success', text: 'Shop description saved.' });
    } catch (error) {
      setDescriptionMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Failed to save shop description.',
      });
    } finally {
      setDescriptionBusy(false);
    }
  }

  async function handleSaveTelegramUsername() {
    setTelegramBusy(true);
    setTelegramMessage(null);
    try {
      await updateOwnTelegramUsername(telegramUsername);
      setTelegramMessage({ kind: 'success', text: 'Telegram username saved.' });
    } catch (error) {
      setTelegramMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Failed to save Telegram username.',
      });
    } finally {
      setTelegramBusy(false);
    }
  }

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
  // Temporary kill-switch (MERCHANT_ACCOUNT_EDITING_ENABLED): merchants see a
  // notice instead of the editing cards; super admin is unaffected.
  const editingDisabled = role === 'admin' && !MERCHANT_ACCOUNT_EDITING_ENABLED;

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

          {editingDisabled && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="lock-closed-outline" size={20} color={colors.primary} />
                <Text style={styles.cardTitle}>Account editing disabled</Text>
              </View>
              <Text style={styles.cardHint}>
                Account editing is temporarily unavailable. Contact the super
                admin for any changes, including bank details.
              </Text>
            </View>
          )}

          {!editingDisabled && (<>
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

          {role === 'admin' && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="storefront-outline" size={20} color={colors.primary} />
                <Text style={styles.cardTitle}>Shop Description</Text>
              </View>
              <Text style={styles.cardHint}>
                A short line about your shop, shown with your logo in the
                shoppers' Store list.
              </Text>
              <TextInput
                style={[styles.input, styles.multilineInput]}
                value={shopDescription}
                onChangeText={setShopDescription}
                placeholder="e.g. Quality school uniforms, delivered fast"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="sentences"
                multiline
                numberOfLines={2}
                maxLength={200}
              />
              {descriptionMessage && (
                <Text
                  style={[
                    styles.feedback,
                    descriptionMessage.kind === 'success' ? styles.successText : styles.errorText,
                  ]}
                >
                  {descriptionMessage.text}
                </Text>
              )}
              <Button
                title="Save Description"
                onPress={handleSaveDescription}
                loading={descriptionBusy}
                disabled={descriptionBusy}
              />
            </View>
          )}

          {role === 'admin' && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.primary} />
                <Text style={styles.cardTitle}>Telegram Username</Text>
              </View>
              <Text style={styles.cardHint}>
                Shoppers tap a chat icon on your product pages and on their
                orders to message this Telegram account directly. Leave empty to
                hide the icon.
              </Text>
              <TextInput
                style={styles.input}
                value={telegramUsername}
                onChangeText={setTelegramUsername}
                placeholder="e.g. shopname (without @)"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {telegramMessage && (
                <Text
                  style={[
                    styles.feedback,
                    telegramMessage.kind === 'success' ? styles.successText : styles.errorText,
                  ]}
                >
                  {telegramMessage.text}
                </Text>
              )}
              <Button
                title="Save Telegram Username"
                onPress={handleSaveTelegramUsername}
                loading={telegramBusy}
                disabled={telegramBusy}
              />
            </View>
          )}

          {role === 'admin' && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="card-outline" size={20} color={colors.primary} />
                <Text style={styles.cardTitle}>Bank Transfer Details</Text>
              </View>
              <Text style={styles.cardHint}>
                Shoppers pay your shop directly by bank transfer. List one or
                more accounts — each with an optional bank name and QR code —
                shown at checkout for your shop's items.
              </Text>
              <BankAccountsEditor value={bankAccounts} onChange={setBankAccounts} />
              {bankMessage && (
                <Text
                  style={[
                    styles.feedback,
                    bankMessage.kind === 'success' ? styles.successText : styles.errorText,
                  ]}
                >
                  {bankMessage.text}
                </Text>
              )}
              <Button
                title="Save Bank Details"
                onPress={handleSaveBankDetails}
                loading={bankBusy}
                disabled={bankBusy}
              />
            </View>
          )}

          {role === 'admin' && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="bicycle-outline" size={20} color={colors.primary} />
                <Text style={styles.cardTitle}>Shipping Fee</Text>
              </View>
              <Text style={styles.cardHint}>
                A flat delivery fee added once per order to your shop's total.
                Leave empty or 0 for free delivery.
              </Text>
              <TextInput
                style={styles.input}
                value={shippingFee}
                onChangeText={setShippingFee}
                placeholder="e.g. 100 (0 or empty = free)"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
              />
              {shippingMessage && (
                <Text
                  style={[
                    styles.feedback,
                    shippingMessage.kind === 'success' ? styles.successText : styles.errorText,
                  ]}
                >
                  {shippingMessage.text}
                </Text>
              )}
              <Button
                title="Save Shipping Fee"
                onPress={handleSaveShippingFee}
                loading={shippingBusy}
                disabled={shippingBusy}
              />
            </View>
          )}

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
          </>)}
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
    multilineInput: {
      minHeight: 64,
      textAlignVertical: 'top',
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
