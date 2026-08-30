import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { Button } from '../../components/Button';
import { fetchTenants, deleteTenant, Tenant } from '../../services/tenants';
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

  async function handleDelete(tenant: Tenant) {
    Alert.alert(
      'Remove tenant?',
      `This will revoke admin access for ${tenant.email ?? tenant.id}. The account itself is not deleted; run the remove-tenant script to fully delete the auth user.`,
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

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
          <Text style={styles.title}>Tenant Admins</Text>
          <Text style={styles.subtitle}>
            Tenant admins can upload products and choose from categories. They cannot manage categories or other tenants.
          </Text>

          <View style={styles.instructionsCard}>
            <Text style={styles.instructionsTitle}>How to add a tenant</Text>
            <Text style={styles.instructionsText}>
              Run the create-tenant script from your project folder:
            </Text>
            <Text style={styles.code} selectable>
              node scripts/create-tenant.js
            </Text>
            <Text style={styles.instructionsText}>
              Set EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the new tenant's email and password in your .env file first.
            </Text>
          </View>

          {tenants.length === 0 && !loading ? (
            <EmptyState message="No tenant admins yet." icon="people-outline" />
          ) : (
            <FlatList
              data={tenants}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <View style={styles.card}>
                  <View style={styles.cardInfo}>
                    <Text style={styles.email} numberOfLines={1}>
                      {item.email ?? 'No email'}
                    </Text>
                    <Text style={styles.meta}>
                      Added {new Date(item.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => handleDelete(item)}
                  >
                    <Ionicons name="trash-outline" size={18} color={colors.danger} />
                  </TouchableOpacity>
                </View>
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
    instructionsCard: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginBottom: spacing.lg,
    },
    instructionsTitle: {
      fontSize: fontSizes.md,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.sm,
    },
    instructionsText: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      marginBottom: spacing.sm,
    },
    code: {
      fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
      fontSize: fontSizes.sm,
      color: colors.primary,
      backgroundColor: colors.background,
      padding: spacing.sm,
      borderRadius: borderRadius.sm,
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
    },
    cardInfo: {
      flex: 1,
    },
    email: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
      marginBottom: spacing.xs,
    },
    meta: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    deleteButton: {
      width: 36,
      height: 36,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.dangerLight,
      borderWidth: 1,
      borderColor: colors.danger,
      justifyContent: 'center',
      alignItems: 'center',
    },
    backButton: {
      marginTop: spacing.md,
    },
  });
