import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { AdminHeader } from '../../components/AdminHeader';
import { Button } from '../../components/Button';
import { fetchTenantById, deleteTenant, Tenant } from '../../services/tenants';
import { AdminStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 800;

type Navigation = NativeStackNavigationProp<AdminStackParamList>;

export function TenantDetailScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute();
  const { tenantId } = route.params as { tenantId: string };
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

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

  function handleDelete() {
    if (!tenant) return;
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
              navigation.navigate('TenantManagement');
            } catch {
              Alert.alert('Error', 'Failed to remove tenant. Please try again.');
            }
          },
        },
      ]
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
    { label: 'Role', value: tenant.role },
    { label: 'Added On', value: new Date(tenant.createdAt).toLocaleString() },
    { label: 'Tenant ID', value: tenant.id },
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
                <Text style={styles.shopName}>{tenant.shopName ?? 'Untitled Shop'}</Text>
                <Text style={styles.username}>@{tenant.username ?? 'unknown'}</Text>
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

            <View style={styles.actions}>
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
    actions: {
      gap: spacing.md,
    },
    deleteButton: {
      marginBottom: spacing.md,
    },
    backButton: {
      marginTop: spacing.md,
    },
  });
