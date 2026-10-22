import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View, Image, Modal, Linking } from 'react-native';
import { useEffect, useState } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { WebHeader } from '../../components/WebHeader';
import { TelegramChatButton } from '../../components/TelegramChatButton';
import { Button } from '../../components/Button';
import { VerificationBadge } from '../../components/VerificationBadge';
import { useApp } from '../../context/AppContext';
import { getItemKey, getItemStatus, getOrderItemsForTenant } from '../../services/orders';
import {
  approvePaymentVerification,
  fetchVerificationsForOrders,
  retryPaymentVerification,
  subscribeToVerifications,
} from '../../services/paymentVerifications';
import { getPaymentProofUrls } from '../../services/images';
import { getPurchasedBookFiles, PurchasedBookFile } from '../../services/productFiles';
import { useResponsive } from '../../hooks/useResponsive';
import { formatFileSize, formatPrice } from '../../utils/format';
import { formatVariantLabel, getUnitPrice } from '../../utils/variants';
import { confirmAction } from '../../utils/confirm';
import { ORDER_STATUSES, ORDER_STATUS_LABELS } from '../../constants/orderStatus';
import { OrderStatus, PaymentVerification } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 900;

/** Item statuses that unlock paid digital downloads (migration 044). */
const DOWNLOAD_UNLOCKED: OrderStatus[] = ['paid', 'on_the_way', 'completed'];

// Mirrors CHECK_TITLES in supabase/functions/_shared/verifyWorkflow.ts.
const VERIFICATION_CHECK_TITLES: Record<string, string> = {
  paymentComplete: 'Payment completed',
  recipientMatch: 'Correct recipient',
  amountMatch: 'Exact amount',
  notPreviouslyClaimed: 'Not previously claimed',
  receiptOwnership: 'Receipt ownership',
  manualApproval: 'Manual approval',
  error: 'Error',
};

export function OrderDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { orderId } = route.params as { orderId: string };
  const { orders, role, currentUserId, updateOrderItemStatus } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [statusError, setStatusError] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [verifications, setVerifications] = useState<PaymentVerification[]>([]);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState('');

  const order = orders.find((o) => o.id === orderId);
  const isWeb = Platform.OS === 'web';
  // Both admin roles can drive the status flow. Tenant admins only ever see
  // orders containing their own products (fetch is scoped by tenant_ids), and
  // RLS rejects their updates on any other order.
  const canManageStatus =
    (role === 'super_admin' || role === 'admin') && !!order;

  // Tenant admins see only their shop's line items inside a mixed order.
  const isTenantAdmin = role === 'admin' && !!currentUserId;
  const visibleItems = order && isTenantAdmin ? getOrderItemsForTenant(order, currentUserId) : order?.items;
  const visibleTotal =
    visibleItems?.reduce((sum, item) => sum + getUnitPrice(item) * item.quantity, 0) ?? 0;

  // Payment proofs are admin-only (migration 040): the super admin sees every
  // shop's proof, a tenant admin sees only their own. Refs are private-bucket
  // paths for new orders and full public URLs for legacy ones.
  const visibleProofRefs =
    order && canManageStatus
      ? isTenantAdmin
        ? Object.entries(order.paymentProofs ?? {})
            .filter(([ownerId]) => ownerId === currentUserId)
            .map(([, ref]) => ref)
        : Object.values(order.paymentProofs ?? {})
      : [];

  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [proofUrls, setProofUrls] = useState<string[]>([]);
  const proofRefsKey = visibleProofRefs.join('|');

  // Paid digital downloads (migration 044), shopper view only: files of each
  // item whose status reached "Order Received", revealed by sign-book-get.
  const [bookFiles, setBookFiles] = useState<Record<string, PurchasedBookFile[]>>({});
  const unlockKey =
    order && !canManageStatus
      ? (visibleItems ?? [])
          .map((item) => `${getItemKey(item)}=${getItemStatus(order, item)}`)
          .join('|')
      : '';

  useEffect(() => {
    if (!order || !unlockKey) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        (visibleItems ?? [])
          .filter((item) => DOWNLOAD_UNLOCKED.includes(getItemStatus(order, item)))
          .map(async (item) => {
            const files = await getPurchasedBookFiles(order.id, item.product.id);
            return [getItemKey(item), files] as const;
          })
      );
      if (cancelled) return;
      setBookFiles((prev) => {
        const next = { ...prev };
        for (const [key, files] of entries) {
          if (files.length > 0) next[key] = files;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, unlockKey]);

  // Resolve proof object keys to short-lived presigned URLs via the
  // r2-upload-sign edge function (admins are authenticated; the private R2
  // bucket is not publicly readable). The function falls back to Supabase
  // signed URLs for not-yet-migrated proofs; legacy full URLs pass through.
  useEffect(() => {
    if (!proofRefsKey) {
      setProofUrls([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const resolved = await getPaymentProofUrls(proofRefsKey.split('|'));
      if (!cancelled) setProofUrls(resolved.filter((u): u is string => !!u));
    })();
    return () => {
      cancelled = true;
    };
  }, [proofRefsKey]);

  // verify.et payment verification (admin-only, migration 040). RLS scopes the
  // read: a tenant admin receives only their shop's attempt, the super admin
  // receives every merchant's attempt on the order.
  useEffect(() => {
    if (!order || !canManageStatus) return;
    let cancelled = false;
    const load = () =>
      fetchVerificationsForOrders([order.id])
        .then((rows) => {
          if (!cancelled) setVerifications(rows);
        })
        .catch(() => {});
    load();
    const unsubscribe = subscribeToVerifications(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, canManageStatus]);

  const shopNameFor = (tenantId: string): string => {
    const item = order?.items.find((i) => {
      const product = i.product as { owner_id?: string; ownerId?: string };
      return product.owner_id === tenantId || product.ownerId === tenantId;
    });
    const product = item?.product as { shop_name?: string; shopName?: string } | undefined;
    return product?.shop_name || product?.shopName || 'Shop';
  };

  const runVerificationAction = (
    action: 'retry' | 'approve',
    verification: PaymentVerification
  ) => {
    if (!order) return;
    confirmAction(
      action === 'retry' ? 'Retry verification' : 'Approve payment',
      action === 'retry'
        ? 'Submit this shop\'s payment proof to verify.et again?'
        : 'Mark this payment as verified? Only approve after checking the proof yourself.',
      action === 'retry' ? 'Retry' : 'Approve',
      async () => {
        setVerifyBusy(true);
        setVerifyError('');
        try {
          if (action === 'retry') {
            await retryPaymentVerification(order.id, verification.tenantId);
          } else {
            await approvePaymentVerification(order.id, verification.tenantId);
          }
          setVerifications(await fetchVerificationsForOrders([order.id]));
        } catch (error) {
          setVerifyError(error instanceof Error ? error.message : 'Action failed. Please try again.');
        } finally {
          setVerifyBusy(false);
        }
      }
    );
  };

  // Admins drive the status of each line item individually (per-item chips
  // under every item below); shoppers only see the read-only per-item status.
  const changeItemStatus = async (itemKey: string, status: OrderStatus) => {
    if (!order) return;
    setStatusBusy(true);
    setStatusError('');
    try {
      await updateOrderItemStatus(order.id, itemKey, status);
    } catch {
      setStatusError('Failed to update the item status. Please try again.');
    } finally {
      setStatusBusy(false);
    }
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
                order.status === 'on_the_way' && styles.onTheWayBadge,
                order.status === 'completed' && styles.completedBadge,
              ]}
            >
              <Text style={styles.badgeText}>{ORDER_STATUS_LABELS[order.status]}</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items</Text>
            {(visibleItems ?? []).map((item) => {
              const itemKey = getItemKey(item);
              const itemStatus = getItemStatus(order, item);
              return (
                <View key={itemKey} style={styles.itemBlock}>
                  <View style={styles.itemRow}>
                    <Text style={styles.itemName}>
                      {item.quantity} × {item.product.name}
                      {formatVariantLabel(item) ? ` (${formatVariantLabel(item)})` : ''}
                    </Text><View style={styles.itemRowEnd}>
                      <Text style={styles.itemPrice}>
                        {formatPrice(getUnitPrice(item) * item.quantity)}
                      </Text>
                      {/* Shopper ↔ shop DM about this specific item; admins
                          (super/tenant) don't get it. Prefer the snake_case
                          username stamped onto the snapshot at order time
                          (migration 025), same as owner_id/shop_name; fall
                          back to the camelCase field carried by locally-built
                          orders that haven't been re-read from the DB yet.
                          Items with neither (orders placed before 025, or a
                          shop with no username) render no button. */}
                      {!canManageStatus && (
                        <TelegramChatButton
                          username={
                            (item.product as { telegram_username?: string }).telegram_username ||
                            item.product.ownerTelegramUsername
                          }
                          size={20}
                        />
                      )}
                    </View>
                  </View>
                  {(item.fieldAnswers ?? []).map((answer) => (
                    <Text key={answer.label} style={styles.itemAnswer}>
                      {answer.label}: {answer.value}
                    </Text>
                  ))}
                  {canManageStatus ? (
                    <View style={styles.statusChips}>
                      {ORDER_STATUSES.map((status) => {
                        const active = itemStatus === status;
                        return (
                          <TouchableOpacity
                            key={status}
                            style={[styles.statusChip, active && styles.statusChipActive]}
                            disabled={statusBusy}
                            onPress={() => changeItemStatus(itemKey, status).catch(() => {})}
                          >
                            <Text
                              style={[
                                styles.statusChipText,
                                active && styles.statusChipTextActive,
                              ]}
                            >
                              {ORDER_STATUS_LABELS[status]}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ) : (
                    <Text style={styles.itemStatusLabel}>
                      Status: {ORDER_STATUS_LABELS[itemStatus]}
                    </Text>
                  )}
                  {/* Paid digital downloads (migration 044) — shopper view;
                      only populated for items past "Order Received". */}
                  {(bookFiles[itemKey] ?? []).map((file) => (
                    <TouchableOpacity
                      key={file.url}
                      style={styles.downloadRow}
                      onPress={() => Linking.openURL(file.url)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="document-text-outline" size={18} color={colors.primary} />
                      <Text style={styles.downloadName} numberOfLines={1}>
                        {file.name}
                      </Text>
                      <Text style={styles.downloadSize}>{formatFileSize(file.sizeBytes)}</Text>
                      <Ionicons name="download-outline" size={18} color={colors.primary} />
                    </TouchableOpacity>
                  ))}
                </View>
              );
            })}
            {isTenantAdmin && visibleItems && visibleItems.length < order.items.length && (
              <Text style={styles.sharedHint}>
                Showing {visibleItems.length} of {order.items.length} items — only your shop's
                items are visible.
              </Text>
            )}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>
                {formatPrice(isTenantAdmin ? visibleTotal : order.total)}
              </Text>
            </View>
            {canManageStatus && !!statusError && (
              <Text style={styles.statusError}>{statusError}</Text>
            )}
          </View>

          {order.studentName && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Student Name</Text>
              <Text style={styles.paymentText}>{order.studentName}</Text>
            </View>
          )}

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
            <Text style={styles.paymentText}>Bank Transfer</Text>
            {proofUrls.length > 0 && (
              <View style={styles.proofGrid}>
                {proofUrls.map((url) => (
                  <TouchableOpacity key={url} onPress={() => setZoomedImage(url)}>
                    <Image source={{ uri: url }} style={styles.proofThumb} resizeMode="cover" />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          {canManageStatus && verifications.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Payment Verification</Text>
              {verifications.map((verification) => (
                <View key={verification.id} style={styles.verificationBlock}>
                  <View style={styles.verificationHeader}>
                    <Text style={styles.verificationShop}>{shopNameFor(verification.tenantId)}</Text>
                    <VerificationBadge status={verification.status} />
                  </View>
                  {verification.status === 'pending' && (
                    <Text style={styles.verificationHint}>
                      Checking the payment proof with verify.et…
                    </Text>
                  )}
                  {Object.entries(verification.checks).map(([key, check]) => (
                    <View key={key} style={styles.checkRow}>
                      <Ionicons
                        name={
                          check.result === 'pass'
                            ? 'checkmark-circle'
                            : check.result === 'fail'
                              ? 'close-circle'
                              : 'alert-circle'
                        }
                        size={16}
                        color={
                          check.result === 'pass'
                            ? colors.success
                            : check.result === 'fail'
                              ? colors.danger
                              : colors.warning
                        }
                      />
                      <Text style={styles.checkText}>
                        {VERIFICATION_CHECK_TITLES[key] ?? key}: {check.reason}
                      </Text>
                    </View>
                  ))}
                  {verification.paidAmount != null && (
                    <Text style={styles.verificationMeta}>
                      Paid {formatPrice(verification.paidAmount)}
                      {verification.expectedAmount != null &&
                        ` · expected ${formatPrice(verification.expectedAmount)}`}
                    </Text>
                  )}
                  {(verification.payer || verification.reference || verification.transactionDate) && (
                    <Text style={styles.verificationMeta}>
                      {[
                        verification.payer && `Payer: ${verification.payer}`,
                        verification.reference && `Ref: ${verification.reference}`,
                        verification.transactionDate &&
                          `Date: ${new Date(verification.transactionDate).toLocaleString()}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  )}
                  {(verification.status === 'error' ||
                    verification.status === 'failed' ||
                    verification.status === 'needs_review') && (
                    <View style={styles.verificationActions}>
                      {(verification.status === 'error' || verification.status === 'failed') && (
                        <Button
                          title="Retry verification"
                          variant="outline"
                          loading={verifyBusy}
                          onPress={() => runVerificationAction('retry', verification)}
                        />
                      )}
                      {verification.status === 'needs_review' && (
                        <>
                          <Button
                            title="Approve payment"
                            loading={verifyBusy}
                            onPress={() => runVerificationAction('approve', verification)}
                          />
                          <Button
                            title="Retry verification"
                            variant="outline"
                            loading={verifyBusy}
                            onPress={() => runVerificationAction('retry', verification)}
                          />
                        </>
                      )}
                    </View>
                  )}
                </View>
              ))}
              {!!verifyError && <Text style={styles.statusError}>{verifyError}</Text>}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Fullscreen payment proof zoom. */}
      <Modal
        visible={!!zoomedImage}
        transparent={false}
        animationType="fade"
        onRequestClose={() => setZoomedImage(null)}
      >
        <TouchableOpacity
          style={styles.zoomOverlay}
          activeOpacity={1}
          onPress={() => setZoomedImage(null)}
        >
          <Ionicons name="close" size={28} color="#fff" style={styles.zoomClose} />
          {zoomedImage ? (
            <Image source={{ uri: zoomedImage }} style={styles.zoomImage} resizeMode="contain" />
          ) : null}
        </TouchableOpacity>
      </Modal>
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
  onTheWayBadge: {
    backgroundColor: colors.primary,
  },
  completedBadge: {
    backgroundColor: colors.success,
  },
  badgeText: {
    fontSize: fontSizes.xs,
    fontWeight: '600',
    color: colors.surface,
  },
  statusChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statusChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  statusChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  statusChipText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  statusChipTextActive: {
    color: colors.surface,
  },
  proofGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  proofThumb: {
    width: 72,
    height: 72,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
  },
  zoomOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomClose: {
    position: 'absolute',
    top: 48,
    left: 24,
    zIndex: 1,
  },
  zoomImage: {
    width: '90%',
    height: '80%',
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
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  itemRowEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  itemBlock: {
    marginBottom: spacing.md,
  },
  itemStatusLabel: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  downloadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginTop: spacing.xs,
  },
  downloadName: {
    flex: 1,
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  downloadSize: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
  },
  itemAnswer: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    marginTop: spacing.xs,
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
  sharedHint: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    fontStyle: 'italic',
    marginTop: spacing.xs,
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
  verificationBlock: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.md,
  },
  verificationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  verificationShop: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
    flex: 1,
  },
  verificationHint: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  checkText: {
    fontSize: fontSizes.sm,
    color: colors.text,
    flex: 1,
  },
  verificationMeta: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  verificationActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    flexWrap: 'wrap',
  },
});
