import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { AdminHeader } from '../../components/AdminHeader';
import { BankAccountsEditor } from '../../components/BankAccountsEditor';
import { Button } from '../../components/Button';
import {
  fetchTenantById,
  deleteTenant,
  adminUpdateTenant,
  adminSetTenantPassword,
  adminSetTenantTelegramChat,
  adminSetTenantTelegramUsername,
  adminSetTenantBankAccounts,
  adminSetTenantShippingFee,
  adminSetTenantShopLogo,
  adminSetTenantShopDescription,
  adminSetTenantActive,
  Tenant,
} from '../../services/tenants';
import { uploadShopLogo } from '../../services/images';
import { confirmAction } from '../../utils/confirm';
import { AdminStackParamList } from '../../types/navigation';
import { BankAccount } from '../../types';
import { useResponsive } from '../../hooks/useResponsive';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 800;

type Navigation = NativeStackNavigationProp<AdminStackParamList>;

export function TenantDetailScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute();
  const { tenantId } = route.params as { tenantId: string };
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState(false);
  const [editUsername, setEditUsername] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editShopName, setEditShopName] = useState('');
  const [editShopDescription, setEditShopDescription] = useState('');
  const [editShopLogoUrl, setEditShopLogoUrl] = useState('');
  const [logoUploading, setLogoUploading] = useState(false);
  const [editTelegramChatId, setEditTelegramChatId] = useState('');
  const [editTelegramUsername, setEditTelegramUsername] = useState('');
  const [editBankAccounts, setEditBankAccounts] = useState<BankAccount[]>([]);
  const [editShippingFee, setEditShippingFee] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editMessage, setEditMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  function startEditing() {
    if (!tenant) return;
    setEditUsername(tenant.username ?? '');
    setEditEmail(tenant.email ?? '');
    setEditShopName(tenant.shopName ?? '');
    setEditShopDescription(tenant.shopDescription ?? '');
    setEditShopLogoUrl(tenant.shopLogoUrl ?? '');
    setLogoUploading(false);
    setEditTelegramChatId(tenant.telegramChatId ?? '');
    setEditTelegramUsername(tenant.telegramUsername ?? '');
    setEditBankAccounts(
      tenant.bankAccounts.length > 0 ? tenant.bankAccounts : [{ accountNumber: '' }]
    );
    setEditShippingFee(tenant.shippingFee ? String(Math.round(tenant.shippingFee)) : '');
    setEditPassword('');
    setEditMessage(null);
    setEditing(true);
  }

  /** Replace the tenant's shop logo; resized to 400px for the store filter. */
  async function pickEditShopLogo() {
    let localUri: string | null = null;
    if (Platform.OS === 'web') {
      const { pickImagesWeb } = await import('../../lib/image-web');
      const uris = await pickImagesWeb();
      localUri = uris[0] ?? null;
    } else {
      const ImagePicker = await import('expo-image-picker');
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.9,
      });
      localUri = !result.canceled ? (result.assets[0]?.uri ?? null) : null;
    }
    if (!localUri) return;

    setLogoUploading(true);
    try {
      const url = await uploadShopLogo(localUri);
      setEditShopLogoUrl(url);
    } catch {
      Alert.alert('Upload Failed', 'Could not upload the logo. Please try again.');
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleSave() {
    if (!tenant) return;
    if (!editShopLogoUrl.trim()) {
      setEditMessage({ kind: 'error', text: 'Shop logo is required.' });
      return;
    }
    const accounts = editBankAccounts.filter((a) => a.accountNumber.trim());
    if (accounts.length === 0) {
      setEditMessage({ kind: 'error', text: 'Add at least one bank account with an account number.' });
      return;
    }
    const feeText = editShippingFee.trim();
    const fee = feeText === '' ? null : Number(feeText);
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
      setEditMessage({ kind: 'error', text: 'Enter a valid shipping fee in Birr.' });
      return;
    }
    setSaving(true);
    setEditMessage(null);
    try {
      await adminUpdateTenant(
        tenant.id,
        editUsername,
        editEmail,
        editShopName
      );
      if (editShopLogoUrl.trim() !== (tenant.shopLogoUrl ?? '').trim()) {
        await adminSetTenantShopLogo(tenant.id, editShopLogoUrl);
      }
      if (
        editShopDescription.trim() !== (tenant.shopDescription ?? '').trim()
      ) {
        await adminSetTenantShopDescription(tenant.id, editShopDescription);
      }
      if (
        editTelegramChatId.trim() !== (tenant.telegramChatId ?? '').trim()
      ) {
        await adminSetTenantTelegramChat(tenant.id, editTelegramChatId);
      }
      if (
        editTelegramUsername.trim().replace(/^@/, '') !==
        (tenant.telegramUsername ?? '').trim().replace(/^@/, '')
      ) {
        await adminSetTenantTelegramUsername(tenant.id, editTelegramUsername);
      }
      const sameAccounts =
        accounts.length === tenant.bankAccounts.length &&
        accounts.every((a, i) => {
          const current = tenant.bankAccounts[i];
          return (
            current &&
            a.accountNumber.trim() === current.accountNumber &&
            (a.bankName ?? '').trim() === (current.bankName ?? '').trim() &&
            (a.qrImageUrl ?? '').trim() === (current.qrImageUrl ?? '').trim()
          );
        });
      if (!sameAccounts) {
        await adminSetTenantBankAccounts(tenant.id, accounts);
      }
      const newFee = fee && fee > 0 ? fee : null;
      if (newFee !== tenant.shippingFee) {
        await adminSetTenantShippingFee(tenant.id, newFee);
      }
      if (editPassword.trim()) {
        await adminSetTenantPassword(tenant.id, editPassword.trim());
      }
      setEditing(false);
      await loadTenant();
      Alert.alert(
        'Tenant Updated',
        editPassword.trim()
          ? 'Account details and password were updated.'
          : 'Account details were updated.'
      );
    } catch (error) {
      setEditMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Failed to update tenant.',
      });
    } finally {
      setSaving(false);
    }
  }

  const loadTenant = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchTenantById(tenantId);
      setTenant(data);
    } catch (error) {
      console.error('Failed to load tenant:', error);
      Alert.alert('Error', 'Failed to load tenant details.');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    loadTenant();
  }, [loadTenant]);

  async function performDelete() {
    if (!tenant) return;
    try {
      await deleteTenant(tenant.id);
      navigation.navigate('TenantManagement');
    } catch (error) {
      console.error('Failed to remove tenant:', error);
      Alert.alert('Error', 'Failed to remove tenant. Please try again.');
    }
  }

  function handleDelete() {
    if (!tenant) return;
    confirmAction(
      'Remove tenant?',
      `This will permanently delete ${tenant.shopName ?? tenant.username ?? tenant.id}. Their username and password will no longer work.`,
      'Remove',
      performDelete
    );
  }

  async function setActive(next: boolean) {
    if (!tenant) return;
    const previous = tenant;
    setTenant({ ...tenant, isActive: next });
    try {
      await adminSetTenantActive(tenant.id, next);
    } catch (error) {
      setTenant(previous);
      const message = error instanceof Error ? error.message : 'Failed to update shop status.';
      Alert.alert('Error', message);
    }
  }

  function handleToggleActive(next: boolean) {
    if (!tenant) return;
    if (next) {
      void setActive(true);
      return;
    }
    confirmAction(
      'Switch off shop?',
      `"${tenant.shopName ?? 'Untitled Shop'}" will disappear from the shop and @${tenant.username ?? 'unknown'} will lose access until you switch it back on.`,
      'Switch Off',
      () => setActive(false)
    );
  }

  const isWeb = Platform.OS === 'web';

  if (loading) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen centered>
          <Text style={styles.loadingText}>Loading tenant details...</Text>
        </Screen>
      </>
    );
  }

  if (!tenant) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen centered>
          <Text style={styles.loadingText}>Tenant not found.</Text>
          <Button
            title="Back"
            onPress={() => navigation.goBack()}
            variant="outline"
            style={styles.backButton}
          />
        </Screen>
      </>
    );
  }

  const detailItems = [
    { label: 'Shop Name', value: tenant.shopName ?? 'Untitled Shop' },
    { label: 'Username', value: tenant.username ?? '—' },
    { label: 'Email', value: tenant.email ?? '—' },
    { label: 'Telegram Group Chat ID', value: tenant.telegramChatId ?? 'Not set' },
    { label: 'Telegram Username', value: tenant.telegramUsername ? `@${tenant.telegramUsername}` : 'Not set' },
    {
      label: 'Bank Accounts',
      value:
        tenant.bankAccounts.length > 0
          ? tenant.bankAccounts
              .map((a) => (a.bankName ? `${a.bankName} — ${a.accountNumber}` : a.accountNumber))
              .join('\n')
          : 'Not set',
    },
    {
      label: 'Shipping Fee',
      value: tenant.shippingFee ? `${Math.round(tenant.shippingFee).toLocaleString('en-US')} ETB per order` : 'Free',
    },
    { label: 'Role', value: tenant.role },
    { label: 'Added On', value: new Date(tenant.createdAt).toLocaleString() },
    { label: 'Tenant Code', value: tenant.code ?? '—' },
  ];

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.container}>
            <View style={styles.header}>
              <View style={styles.headerIcon}>
                <Ionicons name="storefront-outline" size={32} color={colors.primary} />
              </View>
              <View style={styles.headerText}>
                <Text style={[styles.shopName, isPhone && styles.shopNameCompact]}>
                  {tenant.shopName ?? 'Untitled Shop'}
                </Text>
                <Text style={styles.username}>
                  @{tenant.username ?? 'unknown'}
                  {tenant.code ? `  ·  ${tenant.code}` : ''}
                </Text>
              </View>
            </View>

            {editing ? (
              <View style={styles.card}>
                <Text style={styles.editTitle}>Edit Account</Text>
                <Text style={styles.editLabel}>Gateway (username)</Text>
                <TextInput
                  style={styles.editInput}
                  value={editUsername}
                  onChangeText={setEditUsername}
                  placeholder="Gateway"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.editLabel}>Email (used for login)</Text>
                <TextInput
                  style={styles.editInput}
                  value={editEmail}
                  onChangeText={setEditEmail}
                  placeholder="Email"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
                <Text style={styles.editLabel}>Shop name</Text>
                <TextInput
                  style={styles.editInput}
                  value={editShopName}
                  onChangeText={setEditShopName}
                  placeholder="Shop name"
                  placeholderTextColor={colors.textSecondary}
                />
                <Text style={styles.editLabel}>Shop description</Text>
                <TextInput
                  style={[styles.editInput, styles.multilineInput]}
                  value={editShopDescription}
                  onChangeText={setEditShopDescription}
                  placeholder="Short line about the shop, shown in the Store list"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="sentences"
                  multiline
                  numberOfLines={2}
                  maxLength={200}
                />
                <Text style={styles.editLabel}>Shop logo</Text>
                {editShopLogoUrl ? (
                  <View style={styles.qrPreviewRow}>
                    <Image
                      source={{ uri: editShopLogoUrl }}
                      style={styles.logoPreview}
                      resizeMode="cover"
                    />
                    <TouchableOpacity onPress={() => setEditShopLogoUrl('')}>
                      <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.qrPickButton, logoUploading && styles.qrPickButtonDisabled]}
                    onPress={() => pickEditShopLogo().catch(() => {})}
                    disabled={logoUploading}
                  >
                    <Ionicons
                      name={logoUploading ? 'hourglass-outline' : 'image-outline'}
                      size={16}
                      color={colors.primary}
                    />
                    <Text style={styles.qrPickButtonText}>
                      {logoUploading ? 'Uploading logo…' : 'Upload shop logo'}
                    </Text>
                  </TouchableOpacity>
                )}
                <Text style={styles.editLabel}>Telegram group chat ID</Text>
                <TextInput
                  style={styles.editInput}
                  value={editTelegramChatId}
                  onChangeText={setEditTelegramChatId}
                  placeholder="e.g. -1001234567890 — orders for this shop are posted here"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                />
                <Text style={styles.editLabel}>Telegram username</Text>
                <TextInput
                  style={styles.editInput}
                  value={editTelegramUsername}
                  onChangeText={setEditTelegramUsername}
                  placeholder="e.g. shopname — shoppers chat with this account"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.editLabel}>Bank accounts</Text>
                <BankAccountsEditor value={editBankAccounts} onChange={setEditBankAccounts} />
                <Text style={styles.editLabel}>Shipping fee (Birr — empty = free delivery)</Text>
                <TextInput
                  style={styles.editInput}
                  value={editShippingFee}
                  onChangeText={setEditShippingFee}
                  placeholder="e.g. 100"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="number-pad"
                />
                <Text style={styles.editLabel}>New password</Text>
                <TextInput
                  style={styles.editInput}
                  value={editPassword}
                  onChangeText={setEditPassword}
                  placeholder="Leave blank to keep current password"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry
                />
                {editMessage && (
                  <Text
                    style={[
                      styles.editMessage,
                      editMessage.kind === 'success' ? styles.editSuccess : styles.editError,
                    ]}
                  >
                    {editMessage.text}
                  </Text>
                )}
                <View style={styles.editActions}>
                  <Button
                    title="Save Changes"
                    onPress={handleSave}
                    loading={saving}
                    disabled={saving}
                    style={styles.editSaveButton}
                  />
                  <Button
                    title="Cancel"
                    onPress={() => setEditing(false)}
                    variant="outline"
                    disabled={saving}
                  />
                </View>
              </View>
            ) : (
              <>
              <View style={styles.card}>
                <View style={[styles.row, styles.rowLast]}>
                  <View style={styles.statusText}>
                    <Text style={styles.rowLabel}>Shop active</Text>
                    <Text style={styles.statusHint}>
                      {tenant.isActive
                        ? 'Visible in the shop'
                        : 'Hidden from the shop — tenant is locked out'}
                    </Text>
                  </View>
                  <Switch
                    value={tenant.isActive}
                    onValueChange={handleToggleActive}
                    trackColor={{ false: colors.border, true: colors.primary }}
                  />
                </View>
              </View>
              <View style={styles.card}>
                {detailItems.map((item, index) => (
                  <View
                    key={item.label}
                    style={[
                      styles.row,
                      index === detailItems.length - 1 && styles.rowLast,
                    ]}
                  >
                    <Text style={styles.rowLabel}>{item.label}</Text>
                    <Text style={styles.rowValue}>{item.value}</Text>
                  </View>
                ))}
              </View>
              {tenant.bankAccounts.some((a) => a.qrImageUrl) && (
                <View style={styles.card}>
                  {tenant.bankAccounts
                    .filter((a) => a.qrImageUrl)
                    .map((account) => (
                      <View
                        key={account.accountNumber}
                        style={[styles.row, styles.rowLast]}
                      >
                        <View>
                          <Text style={styles.rowLabel}>
                            QR Code{account.bankName ? ` (${account.bankName})` : ''}
                          </Text>
                          <Image
                            source={{ uri: account.qrImageUrl! }}
                            style={styles.qrDisplay}
                            resizeMode="contain"
                          />
                        </View>
                      </View>
                    ))}
                </View>
              )}
              </>
            )}

            <View style={styles.actions}>
              {!editing && (
                <Button
                  title="Edit Account"
                  onPress={startEditing}
                  style={styles.editAccountButton}
                />
              )}
              <Button
                title="Remove Tenant"
                onPress={handleDelete}
                variant="danger"
                style={styles.deleteButton}
              />
              <Button
                title="Back to Tenants"
                onPress={() => navigation.goBack()}
                variant="outline"
              />
            </View>
          </View>
        </ScrollView>
      </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    scrollContent: {
      flexGrow: 1,
    },
    container: {
      flex: 1,
      maxWidth: MAX_WIDTH,
      width: '100%',
      alignSelf: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      paddingBottom: spacing.xxl,
    },
    loadingText: {
      fontSize: fontSizes.md,
      color: colors.textSecondary,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.lg,
    },
    headerIcon: {
      width: 64,
      height: 64,
      borderRadius: borderRadius.md,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: spacing.md,
    },
    headerText: {
      flex: 1,
    },
    shopName: {
      fontSize: fontSizes.xxl,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.xs,
    },
    shopNameCompact: {
      fontSize: fontSizes.xl,
    },
    username: {
      fontSize: fontSizes.md,
      color: colors.textSecondary,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: spacing.lg,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowLast: {
      borderBottomWidth: 0,
    },
    rowLabel: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
    },
    rowValue: {
      flex: 1,
      textAlign: 'right',
      fontSize: fontSizes.md,
      color: colors.textSecondary,
      marginLeft: spacing.md,
    },
    statusText: {
      flex: 1,
    },
    statusHint: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    actions: {
      gap: spacing.md,
    },
    editAccountButton: {
      marginBottom: spacing.md,
    },
    editTitle: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.xs,
    },
    editLabel: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.textSecondary,
      marginBottom: spacing.xs,
    },
    editInput: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSizes.md,
      color: colors.text,
      marginBottom: spacing.sm,
      ...(Platform.OS === 'web'
        ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
        : {}),
    },
    multilineInput: {
      minHeight: 64,
      textAlignVertical: 'top',
    },
    editMessage: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      marginBottom: spacing.sm,
    },
    editSuccess: {
      color: colors.success,
    },
    editError: {
      color: colors.danger,
    },
    editActions: {
      gap: spacing.md,
    },
    editSaveButton: {
      marginBottom: spacing.md,
    },
    qrPreviewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    logoPreview: {
      width: 72,
      height: 72,
      borderRadius: borderRadius.md,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    qrPickButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.primary,
      borderRadius: borderRadius.sm,
      paddingVertical: spacing.md,
      backgroundColor: colors.background,
      marginBottom: spacing.sm,
    },
    qrPickButtonDisabled: {
      opacity: 0.6,
    },
    qrPickButtonText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
    },
    qrDisplay: {
      width: 160,
      height: 160,
      marginTop: spacing.sm,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.background,
    },
    deleteButton: {
      marginBottom: spacing.md,
    },
    backButton: {
      marginTop: spacing.md,
    },
  });
