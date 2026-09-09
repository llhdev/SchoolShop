import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View, Alert } from 'react-native';
import { useState } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { WebHeader } from '../../components/WebHeader';
import { Button } from '../../components/Button';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 900;

export function OrderDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { orderId } = route.params as { orderId: string };
  const { orders, role, updateOrderStatus } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [statusError, setStatusError] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);

  const order = orders.find((o) => o.id === orderId);
  const isWeb = Platform.OS === 'web';
  const canManageStatus =
    role === 'super_admin' && !!order && (order.status === 'pending' || order.status === 'paid');

  const changeStatus = async (status: 'completed' | 'failed') => {
    if (!order) return;
    setStatusBusy(true);
    setStatusError('');
    try {
      await updateOrderStatus(order.id, status);
    } catch {
      setStatusError('Failed to update the order status. Please try again.');
    } finally {
      setStatusBusy(false);
    }
  };

  const confirmAndFail = () => {
    const fail = () => {
      changeStatus('failed').catch(() => {});
    };
    if (Platform.OS === 'web') {
      const win = globalThis as { confirm?: (message?: string) => boolean };
      if (win.confirm?.('Mark this order as failed?')) fail();
      return;
    }
    Alert.alert('Mark as failed?', 'This marks the order as failed.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mark failed', style: 'destructive', onPress: fail },
    ]);
  };

  if (!order) {
    return (
      <>
        {isWeb && <WebHeader showSearch={false} />}
        <Screen>
          <EmptyState message="Order not found." icon="alert-circle-outline" />
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <WebHeader showSearch={false} />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.container}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, isPhone && styles.titleCompact]}>Order Details</Text>
            {isWeb && (
              <TouchableOpacity
                style={styles.homeLink}
                onPress={() => navigation.navigate('UserTabs', { screen: 'Home' })}
              >
                <Ionicons name="arrow-back" size={16} color={colors.primary} />
                <Text style={[styles.homeLinkText, isPhone && styles.homeLinkTextCompact]}>
                  Continue Shopping
                </Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.header}>
            <View>
              <Text style={styles.date}>
                {new Date(order.createdAt).toLocaleString()}
              </Text>
            </View>
            <View
              style={[
                styles.badge,
                order.status === 'paid' && styles.paidBadge,
                order.status === 'pending' && styles.pendingBadge,
                order.status === 'delivered' && styles.deliveredBadge,
                order.status === 'completed' && styles.completedBadge,
                order.status === 'failed' && styles.failedBadge,
              ]}
            >
              <Text style={styles.badgeText}>{order.status}</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items</Text>
            {order.items.map((item) => (
              <View key={`${item.product.id}-${item.selectedImageIndex}`} style={styles.itemRow}>
                <Text style={styles.itemName}>
                  {item.quantity} × {item.product.name}
                </Text>
                <Text style={styles.itemPrice}>
                  {formatPrice(item.product.price * item.quantity)}
                </Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>{formatPrice(order.total)}</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delivery Location</Text>
            <Text style={styles.paymentText}>{order.location || 'Not provided'}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Phone Number</Text>
            <Text style={styles.paymentText}>{order.phoneNumber || 'Not provided'}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Payment</Text>
            <Text style={styles.paymentText}>
              {order.paymentMethod === 'cash_on_delivery'
                ? 'Cash on Delivery'
                : 'Paid Online'}
            </Text>
          </View>

          {canManageStatus && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Update Status</Text>
              <View style={styles.statusButtons}>
                <Button
                  title="Mark as Completed"
                  variant="primary"
                  disabled={statusBusy}
                  style={styles.statusButton}
                  onPress={() => changeStatus('completed').catch(() => {})}
                />
                <Button
                  title="Mark as Failed"
                  variant="danger"
                  disabled={statusBusy}
                  style={styles.statusButton}
                  onPress={confirmAndFail}
                />
              </View>
              {!!statusError && <Text style={styles.statusError}>{statusError}</Text>}
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  scroll: {
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
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  titleCompact: {
    fontSize: fontSizes.xl,
  },
  homeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  homeLinkText: {
    fontSize: fontSizes.md,
    color: colors.primary,
    fontWeight: '600',
  },
  homeLinkTextCompact: {
    fontSize: fontSizes.sm,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.lg,
  },
  date: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.border,
  },
  pendingBadge: {
    backgroundColor: colors.warning,
  },
  paidBadge: {
    backgroundColor: colors.success,
  },
  deliveredBadge: {
    backgroundColor: colors.primary,
  },
  completedBadge: {
    backgroundColor: colors.success,
  },
  failedBadge: {
    backgroundColor: colors.danger,
  },
  badgeText: {
    fontSize: fontSizes.xs,
    fontWeight: '600',
    color: colors.surface,
    textTransform: 'capitalize',
  },
  statusButtons: {
    gap: spacing.md,
  },
  statusButton: {
    width: '100%',
  },
  statusError: {
    marginTop: spacing.md,
    fontSize: fontSizes.sm,
    color: colors.danger,
  },
  section: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  itemName: {
    fontSize: fontSizes.md,
    color: colors.text,
    flex: 1,
  },
  itemPrice: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  totalLabel: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.text,
  },
  totalValue: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.primary,
  },
  paymentText: {
    fontSize: fontSizes.md,
    color: colors.text,
    textTransform: 'capitalize',
  },
});
