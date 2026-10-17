import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
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
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { BankAccountsEditor } from '../../components/BankAccountsEditor';
import { Button } from '../../components/Button';
import { fetchTenants, createTenant, adminSetTenantActive, adminSetTenantPaymentVerification, Tenant } from '../../services/tenants';
import { fetchPaymentVerificationEnabled, setPaymentVerificationEnabled } from '../../services/settings';
import { uploadShopLogo } from '../../services/images';
import { confirmAction } from '../../utils/confirm';
import { AdminStackParamList } from '../../types/navigation';
import { BankAccount } from '../../types';
import { useResponsive } from '../../hooks/useResponsive';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 800;

type Navigation = NativeStackNavigationProp<AdminStackParamList>;

export function TenantManagementScreen() {
  const navigation = useNavigation<Navigation>();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  /** Runtime kill-switch for the payment verification pipeline (042). */
  const [verificationEnabled, setVerificationEnabled] = useState<boolean | null>(null);
  const [togglingVerification, setTogglingVerification] = useState(false);

  const loadVerificationFlag = useCallback(async () => {
    setVerificationEnabled(await fetchPaymentVerificationEnabled());
  }, []);

  async function toggleVerification(enabled: boolean) {
    setTogglingVerification(true);
    try {
      await setPaymentVerificationEnabled(enabled);
      setVerificationEnabled(enabled);
    } catch (error) {
      console.error('Failed to update verification flag:', error);
      Alert.alert('Error', 'Could not update the payment verification setting. Please try again.');
    } finally {
      setTogglingVerification(false);
    }
  }

  const [username, setUsername] = useState('');
  const [shopName, setShopName] = useState('');
  const [shopDescription, setShopDescription] = useState('');
  const [shopLogoUrl, setShopLogoUrl] = useState('');
  const [logoUploading, setLogoUploading] = useState(false);
  const [email, setEmail] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramUsername, setTelegramUsername] = useState('');
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([{ accountNumber: '' }]);
  const [shippingFee, setShippingFee] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const loadTenants = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchTenants();
      setTenants(data);
    } catch (error) {
      console.error('Failed to load tenants:', error);
      Alert.alert('Error', 'Failed to load tenants. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadTenants();
      loadVerificationFlag();
    }, [loadTenants, loadVerificationFlag])
  );

  function resetForm() {
    setUsername('');
    setShopName('');
    setShopDescription('');
    setShopLogoUrl('');
    setLogoUploading(false);
    setEmail('');
    setTelegramChatId('');
    setTelegramUsername('');
    setBankAccounts([{ accountNumber: '' }]);
    setShippingFee('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  }

  /** Pick the tenant's mandatory shop logo and upload it to the public
   *  shop-logos bucket right away (resized to 400px), so tenant creation
   *  doesn't wait on it. */
  async function pickShopLogo() {
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
      setShopLogoUrl(url);
    } catch {
      Alert.alert('Upload Failed', 'Could not upload the logo. Please try again.');
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleCreate() {
    const cleanUsername = username.trim().toLowerCase();
    const accounts = bankAccounts.filter((a) => a.accountNumber.trim());

    if (!cleanUsername) {
      Alert.alert('Error', 'Please enter a username.');
      return;
    }
    if (!shopName.trim()) {
      Alert.alert('Error', 'Please enter a shop name.');
      return;
    }
    if (!shopLogoUrl) {
      Alert.alert('Error', 'Please upload a shop logo. Every store needs one to appear in the Store filter.');
      return;
    }
    if (accounts.length === 0) {
      Alert.alert('Error', 'Please add at least one bank account with an account number.');
      return;
    }
    const fee = shippingFee.trim() === '' ? null : Number(shippingFee.trim());
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
      Alert.alert('Error', 'Enter a valid shipping fee in Birr (or leave it empty for free delivery).');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match.');
      return;
    }

    setIsCreating(true);
    try {
      const tenant = await createTenant(
        cleanUsername,
        password,
        shopName.trim(),
        email,
        telegramChatId,
        accounts,
        fee,
        shopLogoUrl,
        shopDescription,
        telegramUsername
      );
      setTenants((prev) => [tenant, ...prev]);
      resetForm();
      Alert.alert('Success', `Tenant @${tenant.username} created.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create tenant';
      Alert.alert('Error', message);
    } finally {
      setIsCreating(false);
    }
  }

  function handleView(tenant: Tenant) {
    navigation.navigate('TenantDetail', { tenantId: tenant.id });
  }

  async function setTenantActive(tenant: Tenant, next: boolean) {
    const previous = tenants;
    setTenants((prev) =>
      prev.map((t) => (t.id === tenant.id ? { ...t, isActive: next } : t))
    );
    try {
      await adminSetTenantActive(tenant.id, next);
    } catch (error) {
      setTenants(previous);
      const message = error instanceof Error ? error.message : 'Failed to update shop status.';
      Alert.alert('Error', message);
    }
  }

  function handleToggleActive(tenant: Tenant, next: boolean) {
    if (next) {
      void setTenantActive(tenant, true);
      return;
    }
    confirmAction(
      'Switch off shop?',
      `"${tenant.shopName ?? 'Untitled Shop'}" will disappear from the shop and @${tenant.username ?? 'unknown'} will lose access until you switch it back on.`,
      'Switch Off',
      () => setTenantActive(tenant, false)
    );
  }

  async function setTenantPaymentVerification(tenant: Tenant, next: boolean) {
    const previous = tenants;
    setTenants((prev) =>
      prev.map((t) => (t.id === tenant.id ? { ...t, paymentVerificationEnabled: next } : t))
    );
    try {
      await adminSetTenantPaymentVerification(tenant.id, next);
    } catch (error) {
      setTenants(previous);
      const message = error instanceof Error ? error.message : 'Failed to update payment verification.';
      Alert.alert('Error', message);
    }
  }

  function handleTogglePaymentVerification(tenant: Tenant, next: boolean) {
    if (next) {
      void setTenantPaymentVerification(tenant, true);
      return;
    }
    confirmAction(
      'Turn off payment verification?',
      `Orders for "${tenant.shopName ?? 'Untitled Shop'}" will be placed without verifying the shopper's payment — the proof photo alone will do.`,
      'Turn Off',
      () => setTenantPaymentVerification(tenant, false)
    );
  }

  const isWeb = Platform.OS === 'web';
  const keyboardVerticalOffset = Platform.OS === 'ios' ? 64 : 0;

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={keyboardVerticalOffset}
          style={styles.flex}
        >
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.container}>
              <Text style={[styles.title, isPhone && styles.titleCompact]}>Tenant Admins</Text>
              <Text style={styles.subtitle}>
                Tenant admins can upload products and choose categories. They cannot manage categories or other tenants.
              </Text>

              <View style={styles.formCard}>
                <View style={styles.switchRow}>
                  <View style={styles.switchText}>
                    <Text style={styles.formTitle}>Payment verification</Text>
                    <Text style={styles.switchCaption}>
                      Verify each shop's payment before the order is placed. Off = orders are placed
                      without verification and no verify.et credits are used. Each shop can also be
                      excluded individually with its own switch below.
                    </Text>
                  </View>
                  <Switch
                    value={verificationEnabled ?? false}
                    onValueChange={toggleVerification}
                    disabled={verificationEnabled === null || togglingVerification}
                    trackColor={{ false: colors.border, true: colors.success }}
                  />
                </View>
              </View>

              <View style={styles.formCard}>
                <Text style={styles.formTitle}>Add Tenant</Text>

                <View style={styles.field}>
                  <Text style={styles.label}>Shop Name</Text>
                  <TextInput
                    style={styles.input}
                    value={shopName}
                    onChangeText={setShopName}
                    placeholder="e.g. ABC School Supplies"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="words"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Shop Logo (required)</Text>
                  {shopLogoUrl ? (
                    <View style={styles.qrPreviewRow}>
                      <Image source={{ uri: shopLogoUrl }} style={styles.logoPreview} resizeMode="cover" />
                      <TouchableOpacity onPress={() => setShopLogoUrl('')}>
                        <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={[styles.qrPickButton, logoUploading && styles.qrPickButtonDisabled]}
                      onPress={() => pickShopLogo().catch(() => {})}
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
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Username</Text>
                  <TextInput
                    style={styles.input}
                    value={username}
                    onChangeText={setUsername}
                    placeholder="e.g. tenant1"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Shop Description (optional)</Text>
                  <TextInput
                    style={[styles.input, styles.multilineInput]}
                    value={shopDescription}
                    onChangeText={setShopDescription}
                    placeholder="Short line about the shop, shown in the Store list"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="sentences"
                    multiline
                    numberOfLines={2}
                    maxLength={200}
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Email (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={email}
                    onChangeText={setEmail}
                    placeholder="Leave blank to use the default"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Telegram Group Chat ID (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={telegramChatId}
                    onChangeText={setTelegramChatId}
                    placeholder="e.g. -1001234567890 — orders for this shop are posted here"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Telegram Username (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={telegramUsername}
                    onChangeText={setTelegramUsername}
                    placeholder="e.g. shopname — shoppers chat with this account"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Bank Accounts</Text>
                  <BankAccountsEditor value={bankAccounts} onChange={setBankAccounts} />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Shipping Fee (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={shippingFee}
                    onChangeText={setShippingFee}
                    placeholder="Flat delivery fee in Birr — empty = free"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="number-pad"
                  />
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Password</Text>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.inputWithIcon}
                      value={password}
                      onChangeText={setPassword}
                      placeholder="Min 6 characters"
                      placeholderTextColor={colors.textSecondary}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
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
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Confirm Password</Text>
                  <TextInput
                    style={styles.input}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Re-enter password"
                    placeholderTextColor={colors.textSecondary}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <Button
                  title={isCreating ? 'Creating...' : 'Create Tenant'}
                  onPress={handleCreate}
                  disabled={isCreating}
                />
              </View>

              <Text style={styles.sectionTitle}>Existing Tenants</Text>

              {tenants.length === 0 && !loading ? (
                <EmptyState message="No tenant admins yet." icon="people-outline" />
              ) : (
                <FlatList
                  data={tenants}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      style={styles.card}
                      onPress={() => handleView(item)}
                    >
                      <View style={styles.cardInfo}>
                        <Text style={styles.shopName} numberOfLines={1}>
                          {item.shopName ?? 'Untitled Shop'}
                        </Text>
                        <Text style={styles.meta}>
                          @{item.username ?? 'unknown'}
                          {item.code ? ` · ${item.code}` : ''} · Added {new Date(item.createdAt).toLocaleDateString()}
                        </Text>
                        {!item.isActive && (
                          <Text style={styles.inactiveLabel}>Inactive — hidden from the shop</Text>
                        )}
                        <View style={styles.verifyRow}>
                          <Ionicons name="shield-checkmark-outline" size={14} color={colors.textSecondary} />
                          <Text style={styles.verifyLabel}>Payment verification</Text>
                          <Switch
                            value={item.paymentVerificationEnabled}
                            onValueChange={(value) => handleTogglePaymentVerification(item, value)}
                            trackColor={{ false: colors.border, true: colors.success }}
                          />
                        </View>
                      </View>
                      <View style={styles.cardActions}>
                        <Switch
                          value={item.isActive}
                          onValueChange={(value) => handleToggleActive(item, value)}
                          trackColor={{ false: colors.border, true: colors.primary }}
                        />
                        <TouchableOpacity
                          style={styles.actionButton}
                          onPress={() => handleView(item)}
                        >
                          <Ionicons name="eye-outline" size={18} color={colors.primary} />
                        </TouchableOpacity>
                      </View>
                    </TouchableOpacity>
                  )}
                />
              )}

              <Button
                title="Back to Dashboard"
                onPress={() => navigation.navigate('AdminDashboard')}
                variant="outline"
                style={styles.backButton}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
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
    title: {
      fontSize: fontSizes.xxl,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.sm,
    },
    titleCompact: {
      fontSize: fontSizes.xl,
    },
    subtitle: {
      fontSize: fontSizes.md,
      color: colors.textSecondary,
      marginBottom: spacing.lg,
    },
    formCard: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginBottom: spacing.lg,
    },
    formTitle: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.md,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    switchText: {
      flex: 1,
    },
    switchCaption: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    field: {
      marginBottom: spacing.md,
    },
    label: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
      marginBottom: spacing.xs,
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
    inputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      paddingLeft: spacing.md,
    },
    inputWithIcon: {
      flex: 1,
      paddingVertical: spacing.sm,
      fontSize: fontSizes.md,
      color: colors.text,
      // Icon-wrapped input: suppress the browser focus ring so it doesn't
      // double the outer container's border.
      ...(Platform.OS === 'web'
        ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
        : {}),
    },
    eyeButton: {
      padding: spacing.sm,
    },
    qrPreviewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    qrPreview: {
      width: 96,
      height: 96,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    logoPreview: {
      width: 72,
      height: 72,
      borderRadius: borderRadius.md,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    multilineInput: {
      minHeight: 64,
      textAlignVertical: 'top',
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
    },
    qrPickButtonDisabled: {
      opacity: 0.6,
    },
    qrPickButtonText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
    },
    sectionTitle: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.sm,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginBottom: spacing.md,
      ...(Platform.OS === 'web'
        ? ({
            cursor: 'pointer',
          } as any)
        : {}),
    },
    cardInfo: {
      flex: 1,
    },
    shopName: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
      marginBottom: spacing.xs,
    },
    meta: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    inactiveLabel: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.danger,
      marginTop: spacing.xs,
    },
    verifyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: spacing.sm,
    },
    verifyLabel: {
      flex: 1,
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    cardActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginLeft: spacing.sm,
    },
    actionButton: {
      width: 36,
      height: 36,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    backButton: {
      marginTop: spacing.md,
    },
  });
