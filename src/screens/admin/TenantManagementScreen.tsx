import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { Button } from '../../components/Button';
import { fetchTenants, deleteTenant, createTenant, Tenant } from '../../services/tenants';
import { AdminStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 800;

type Navigation = NativeStackNavigationProp<AdminStackParamList>;

export function TenantManagementScreen() {
  const navigation = useNavigation<Navigation>();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  const [username, setUsername] = useState('');
  const [shopName, setShopName] = useState('');
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
    }, [loadTenants])
  );

  function resetForm() {
    setUsername('');
    setShopName('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  }

  async function handleCreate() {
    const cleanUsername = username.trim().toLowerCase();

    if (!cleanUsername) {
      Alert.alert('Error', 'Please enter a username.');
      return;
    }
    if (!shopName.trim()) {
      Alert.alert('Error', 'Please enter a shop name.');
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
      const tenant = await createTenant(cleanUsername, password, shopName.trim());
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

  function handleDelete(tenant: Tenant) {
    Alert.alert(
      'Remove tenant?',
      `This will revoke admin access for ${tenant.shopName ?? tenant.username ?? tenant.id}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTenant(tenant.id);
              setTenants((prev) => prev.filter((t) => t.id !== tenant.id));
            } catch {
              Alert.alert('Error', 'Failed to remove tenant. Please try again.');
            }
          },
        },
      ]
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
              <Text style={styles.title}>Tenant Admins</Text>
              <Text style={styles.subtitle}>
                Tenant admins can upload products and choose categories. They cannot manage categories or other tenants.
              </Text>

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
                          @{item.username ?? 'unknown'} · Added {new Date(item.createdAt).toLocaleDateString()}
                        </Text>
                      </View>
                      <View style={styles.cardActions}>
                        <TouchableOpacity
                          style={styles.actionButton}
                          onPress={() => handleView(item)}
                        >
                          <Ionicons name="eye-outline" size={18} color={colors.primary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.actionButton}
                          onPress={() => handleDelete(item)}
                        >
                          <Ionicons name="trash-outline" size={18} color={colors.danger} />
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
    },
    eyeButton: {
      padding: spacing.sm,
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
