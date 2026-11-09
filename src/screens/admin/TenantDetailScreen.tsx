import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  Image,
  Modal,
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
  adminSetTenantBranchSelection,
  fetchStaff,
  createStaffAccount,
  updateStaffAccount,
  setStaffPassword,
  deleteStaffAccount,
  StaffAccount,
  Tenant,
} from '../../services/tenants';
import { uploadShopLogo } from '../../services/images';
import { confirmAction } from '../../utils/confirm';
import { AdminStackParamList } from '../../types/navigation';
import { BankAccount, StaffCapabilities } from '../../types';
import { useResponsive } from '../../hooks/useResponsive';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 800;

/** Staff capability toggles with their one-line descriptions (migration 045). */
const STAFF_CAPABILITIES: {
  key: keyof StaffCapabilities;
  title: string;
  description: string;
}[] = [
  {
    key: 'financial',
    title: 'Financial Admin',
    description: 'Verifies payments and marks orders paid.',
  },
  {
    key: 'shop',
    title: 'Shop Admin',
    description: "Manages the shop's products and catalog.",
  },
  {
    key: 'branch',
    title: 'Branch Admin',
    description: 'Receives, ships, completes, and cancels orders for one branch.',
  },
];

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

  // Staff accounts (migration 045): separate auth users scoped to this shop.
  // Since migration 046 a Branch Admin account IS a branch — the label is the
  // branch name and the service keeps the branch row in sync.
  const [staff, setStaff] = useState<StaffAccount[]>([]);
  const [staffModal, setStaffModal] = useState<{
    mode: 'create' | 'edit' | 'password';
    staff?: StaffAccount;
  } | null>(null);
  const [staffLabel, setStaffLabel] = useState('');
  const [staffPasswordInput, setStaffPasswordInput] = useState('');
  const [staffCaps, setStaffCaps] = useState<StaffCapabilities>({
    financial: false,
    shop: false,
    branch: false,
  });
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);

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

  const loadStaff = useCallback(async () => {
    try {
      setStaff(await fetchStaff(tenantId));
    } catch (error) {
      console.error('Failed to load staff:', error);
    }
  }, [tenantId]);

  useEffect(() => {
    loadTenant();
    loadStaff();
  }, [loadTenant, loadStaff]);

  /** Super admin flips whether shoppers pick a branch at checkout (046);
   *  optimistic, same pattern as the shop-active switch. */
  async function setBranchSelection(next: boolean) {
    if (!tenant) return;
    const previous = tenant;
    setTenant({ ...tenant, branchSelectionEnabled: next });
    try {
      await adminSetTenantBranchSelection(tenant.id, next);
    } catch (error) {
      setTenant(previous);
      const message = error instanceof Error ? error.message : 'Failed to update branch selection.';
      Alert.alert('Error', message);
    }
  }

  function openCreateStaff() {
    setStaffLabel('');
    setStaffPasswordInput('');
    setStaffCaps({ financial: false, shop: false, branch: false });
    setStaffError(null);
    setStaffModal({ mode: 'create' });
  }

  function openEditStaff(account: StaffAccount) {
    setStaffLabel(account.label ?? '');
    setStaffPasswordInput('');
    setStaffCaps(account.capabilities);
    setStaffError(null);
    setStaffModal({ mode: 'edit', staff: account });
  }

  function openPasswordStaff(account: StaffAccount) {
    setStaffPasswordInput('');
    setStaffError(null);
    setStaffModal({ mode: 'password', staff: account });
  }

  async function handleStaffSubmit() {
    if (!tenant || !staffModal) return;
    const { mode, staff: target } = staffModal;
    if (mode !== 'password') {
      if (!staffCaps.financial && !staffCaps.shop && !staffCaps.branch) {
        setStaffError('Turn on at least one capability.');
        return;
      }
      // A Branch Admin's label is the branch name shoppers see at checkout.
      if (staffCaps.branch && !staffLabel.trim()) {
        setStaffError('A Branch Admin needs a label — it becomes the branch name.');
        return;
      }
    }
    if (mode !== 'edit' && staffPasswordInput.length < 6) {
      setStaffError('Password must be at least 6 characters.');
      return;
    }
    setStaffSaving(true);
    setStaffError(null);
    try {
      if (mode === 'create') {
        await createStaffAccount(
          { id: tenant.id, username: tenant.username },
          {
            label: staffLabel,
            password: staffPasswordInput,
            capabilities: staffCaps,
          }
        );
      } else if (mode === 'edit' && target) {
        await updateStaffAccount(target, {
          label: staffLabel,
          capabilities: staffCaps,
        });
      } else if (mode === 'password' && target) {
        await setStaffPassword(target.id, staffPasswordInput);
      }
      setStaffModal(null);
      await loadStaff();
      Alert.alert(
        'Success',
        mode === 'password'
          ? 'Password updated.'
          : mode === 'create'
            ? 'Staff account created. Staff log in with the shop username and this password.'
            : 'Staff account updated.'
      );
    } catch (error) {
      setStaffError(error instanceof Error ? error.message : 'Failed to save staff account.');
    } finally {
      setStaffSaving(false);
    }
  }

  function handleRemoveStaff(account: StaffAccount) {
    confirmAction(
      'Remove staff account?',
      `"${account.label ?? account.email ?? account.id}" will no longer be able to log in. Products and orders are not affected.`,
      'Remove',
      async () => {
        try {
          await deleteStaffAccount(account);
          await loadStaff();
        } catch (error) {
          Alert.alert(
            'Error',
            error instanceof Error ? error.message : 'Failed to remove staff account.'
          );
        }
      }
    );
  }

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
                <View style={styles.row}>
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
                <View style={[styles.row, styles.rowLast]}>
                  <View style={styles.statusText}>
                    <Text style={styles.rowLabel}>Branch selection at checkout</Text>
                    <Text style={styles.statusHint}>
                      Let shoppers choose a branch when ordering. Off = branch admins see all shop
                      orders.
                    </Text>
                  </View>
                  <Switch
                    value={tenant.branchSelectionEnabled}
                    onValueChange={(value) => void setBranchSelection(value)}
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

            <View style={styles.card}>
              <View style={styles.sectionBody}>
                <Text style={styles.sectionTitle}>Staff Accounts</Text>
                <Text style={styles.sectionHint}>
                  Staff log in with the shop username (@{tenant.username ?? 'unknown'}) and their own
                  password — the password picks the account. A Branch Admin's label is the branch
                  shoppers pick at checkout.
                </Text>
                {staff.map((account) => {
                  return (
                    <View key={account.id} style={styles.staffRow}>
                      <View style={styles.staffInfo}>
                        <Text style={styles.staffName} numberOfLines={1}>
                          {account.label || account.email || 'Staff'}
                        </Text>
                        {account.label && account.email ? (
                          <Text style={styles.staffEmail} numberOfLines={1}>
                            {account.email}
                          </Text>
                        ) : null}
                        <View style={styles.badgeRow}>
                          {account.capabilities.financial && (
                            <Text style={styles.badge}>Financial</Text>
                          )}
                          {account.capabilities.shop && <Text style={styles.badge}>Shop</Text>}
                          {account.capabilities.branch && (
                            <Text style={styles.badge}>Branch</Text>
                          )}
                        </View>
                      </View>
                      <View style={styles.staffActions}>
                        <TouchableOpacity
                          style={styles.staffActionButton}
                          onPress={() => openEditStaff(account)}
                        >
                          <Ionicons name="create-outline" size={18} color={colors.primary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.staffActionButton}
                          onPress={() => openPasswordStaff(account)}
                        >
                          <Ionicons name="key-outline" size={18} color={colors.primary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.staffActionButton}
                          onPress={() => handleRemoveStaff(account)}
                        >
                          <Ionicons name="trash-outline" size={18} color={colors.danger} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
                {staff.length === 0 && (
                  <Text style={styles.sectionHint}>No staff accounts yet.</Text>
                )}
                <Button
                  title="Add Staff"
                  onPress={openCreateStaff}
                  variant="outline"
                  style={styles.sectionSaveButton}
                />
              </View>
            </View>

            <Modal
              visible={staffModal !== null}
              transparent
              animationType="fade"
              onRequestClose={() => setStaffModal(null)}
            >
              <View style={styles.modalOverlay}>
                <View style={styles.modalCard}>
                  <Text style={styles.editTitle}>
                    {staffModal?.mode === 'create'
                      ? 'Add Staff Account'
                      : staffModal?.mode === 'edit'
                        ? 'Edit Staff Account'
                        : 'Reset Password'}
                  </Text>
                  {staffModal?.mode !== 'password' && (
                    <>
                      <Text style={styles.editLabel}>
                        {staffCaps.branch ? 'Label (required — branch name)' : 'Label (optional)'}
                      </Text>
                      <TextInput
                        style={styles.editInput}
                        value={staffLabel}
                        onChangeText={setStaffLabel}
                        placeholder="e.g. Accountant, Bole branch manager"
                        placeholderTextColor={colors.textSecondary}
                        autoCapitalize="words"
                      />
                      {staffCaps.branch && (
                        <Text style={styles.sectionHint}>
                          This label becomes the branch name shoppers pick at checkout.
                        </Text>
                      )}
                      {STAFF_CAPABILITIES.map((capability) => (
                        <View key={capability.key} style={styles.capabilityRow}>
                          <View style={styles.capabilityText}>
                            <Text style={styles.capabilityTitle}>{capability.title}</Text>
                            <Text style={styles.capabilityDescription}>
                              {capability.description}
                            </Text>
                          </View>
                          <Switch
                            value={staffCaps[capability.key]}
                            onValueChange={(value) =>
                              setStaffCaps((prev) => ({ ...prev, [capability.key]: value }))
                            }
                            trackColor={{ false: colors.border, true: colors.primary }}
                          />
                        </View>
                      ))}
                    </>
                  )}
                  {staffModal?.mode !== 'edit' && (
                    <>
                      <Text style={styles.editLabel}>
                        {staffModal?.mode === 'password' ? 'New password' : 'Password'}
                      </Text>
                      <TextInput
                        style={styles.editInput}
                        value={staffPasswordInput}
                        onChangeText={setStaffPasswordInput}
                        placeholder="Min 6 characters"
                        placeholderTextColor={colors.textSecondary}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </>
                  )}
                  {staffError && (
                    <Text style={[styles.editMessage, styles.editError]}>{staffError}</Text>
                  )}
                  <View style={styles.editActions}>
                    <Button
                      title={staffModal?.mode === 'password' ? 'Set Password' : 'Save'}
                      onPress={handleStaffSubmit}
                      loading={staffSaving}
                      disabled={staffSaving}
                      style={styles.editSaveButton}
                    />
                    <Button
                      title="Cancel"
                      onPress={() => setStaffModal(null)}
                      variant="outline"
                      disabled={staffSaving}
                    />
                  </View>
                </View>
              </View>
            </Modal>

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
    sectionBody: {
      padding: spacing.md,
      gap: spacing.sm,
    },
    sectionTitle: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
    },
    sectionHint: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    sectionSaveButton: {
      marginTop: spacing.sm,
    },
    staffRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.background,
      padding: spacing.sm,
      gap: spacing.sm,
    },
    staffInfo: {
      flex: 1,
      gap: spacing.xs,
    },
    staffName: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
    },
    staffEmail: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    badgeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    badge: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.primary,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      overflow: 'hidden',
    },
    staffActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    staffActionButton: {
      width: 36,
      height: 36,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.lg,
    },
    modalCard: {
      width: '100%',
      maxWidth: 480,
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
    },
    capabilityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    capabilityText: {
      flex: 1,
    },
    capabilityTitle: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
    },
    capabilityDescription: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      marginTop: 2,
    },
  });
