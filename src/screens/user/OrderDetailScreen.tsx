import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Image, Modal, Linking, useWindowDimensions } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { WebHeader } from '../../components/WebHeader';
import { AdminHeader } from '../../components/AdminHeader';
import { TelegramChatButton } from '../../components/TelegramChatButton';
import { Button } from '../../components/Button';
import { VerificationBadge } from '../../components/VerificationBadge';
import { PaymentWarningBadge } from '../../components/PaymentWarningBadge';
import { useApp } from '../../context/AppContext';
import { fetchOrderById, getItemKey, getItemStatus, getOrderItemsForScope, hasPaymentWarning } from '../../services/orders';
import { fetchScopedOrder } from '../../services/orderLines';
import {
  approvePaymentVerification,
  fetchVerificationsForOrders,
  manualVerifyReference,
  retryPaymentVerification,
  setOrderPaymentReference,
  subscribeToVerifications,
} from '../../services/paymentVerifications';
import { getPaymentProofUrls } from '../../services/images';
import { getPurchasedBookFiles, PurchasedBookFile } from '../../services/productFiles';
import { useResponsive } from '../../hooks/useResponsive';
import { formatFileSize, formatPrice } from '../../utils/format';
import { formatVariantLabel, getUnitPrice } from '../../utils/variants';
import { confirmAction } from '../../utils/confirm';
import { notify } from '../../utils/notify';
import { CANCEL_REASONS, ORDER_STATUS_LABELS, cancelRemarkText } from '../../constants/orderStatus';
import { Order, OrderStatus, PaymentVerification, PaymentWarning } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { useThemeColors, spacing, borderRadius, fontSizes, pageWidth, ColorPalette } from '../../constants/theme';

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

// Payment proof zoom viewer (072): step buttons between these bounds.
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

export function OrderDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { orderId } = route.params as { orderId: string };
  const { orders, role, staffSession, effectiveTenantId, updateOrderItemStatus } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [statusError, setStatusError] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [verifications, setVerifications] = useState<PaymentVerification[]>([]);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  // Manual reference entry (migration 067), keyed by tenant id: for warning
  // orders the financial admin types the transaction reference off the
  // receipt image. The server duplicate-checks it on save.
  const [manualRefs, setManualRefs] = useState<Record<string, string>>({});
  const [manualProviders, setManualProviders] = useState<Record<string, 'cbe' | 'telebirr'>>({});
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMessage, setManualMessage] = useState('');
  // Manual verify tool: typed reference checked live against verify.et + the
  // claims ledger (financial staff / super admin). Reasons of a failed run
  // render once, inside the card.
  const [manualVerifyProvider, setManualVerifyProvider] = useState<'cbe' | 'telebirr'>('telebirr');
  const [manualVerifyRef, setManualVerifyRef] = useState('');
  const [manualVerifyBusy, setManualVerifyBusy] = useState(false);
  const [manualVerifyReasons, setManualVerifyReasons] = useState<string[]>([]);

  const contextOrder = orders.find((o) => o.id === orderId);
  // Fallback when an admin viewer's order isn't in context (deep link, or a
  // sync that hasn't finished): the super admin / financial staff read the
  // table directly (064 policy), other staff go through get_scoped_order
  // (070), which applies the same money strip + branch scoping as
  // get_scoped_orders. Shoppers keep the context-only path — their orders
  // always arrive via the shopper sync.
  const [fetchedOrder, setFetchedOrder] = useState<Order | null>(null);
  const [fetchSettled, setFetchSettled] = useState(false);
  const order = contextOrder ?? fetchedOrder ?? undefined;
  // Orders hydrate from cache first and (for Telegram shoppers) re-sync from
  // the server shortly after; give that sync a moment before concluding the
  // order is gone instead of flashing "not found".
  const [notFoundReady, setNotFoundReady] = useState(false);
  useEffect(() => {
    if (order) return;
    const timer = setTimeout(() => setNotFoundReady(true), 2500);
    return () => clearTimeout(timer);
  }, [order]);
  const isWeb = Platform.OS === 'web';
  const isSuperAdmin = role === 'super_admin';
  // This screen is shared between the shopper and admin navigators: admins
  // get the admin chrome and a Back action; shoppers keep Continue Shopping.
  const isAdminViewer = role !== 'user';
  const header = isAdminViewer ? <AdminHeader /> : <WebHeader showSearch={false} />;
  const capabilities = staffSession?.capabilities;
  // Staff drive the status flow only within their capabilities (migration
  // 045); the server RPC re-checks every transition, the UI only offers the
  // valid ones. Shoppers never manage status.
  const canManageStatus =
    !!order &&
    (isSuperAdmin ||
      (role === 'admin' &&
        !!capabilities &&
        (capabilities.financial || capabilities.shop || capabilities.branch)));
  // Money is visible to the super admin and financial staff; shoppers always
  // see their own order totals.
  const canSeeMoney = role === 'user' || isSuperAdmin || !!capabilities?.financial;
  // Proofs: super admin, financial, and branch staff — not shop-only staff.
  const canSeeProofs = isSuperAdmin || !!capabilities?.financial || !!capabilities?.branch;
  // verify.et payment verification reads (badges, retry/approve, recorded
  // references): super admin and financial staff only — the 064 RLS policy
  // gates the rows to them, so branch staff never fetch them.
  const canSeeVerification = isSuperAdmin || !!capabilities?.financial;
  // 073: branch staff also get the manual "type the reference → verify" tool
  // (the edge function scopes their auto-pay to their branch's items) and may
  // mark their scoped items paid. Financial-only surfaces above stay as-is.
  const canManualVerify = canSeeVerification || !!capabilities?.branch;
  // Branch-only caller (no financial read): the verify card's wording and the
  // success toast say "your branch's items" — the server auto-pays only
  // those. Financial staff and the super admin get the whole-shop wording.
  const manualVerifyScopeIsBranch = !canSeeVerification && !!capabilities?.branch;

  // Manual verify tool: which tenant slice it operates on. Staff act for
  // their own shop; the super admin only when the order has exactly one shop
  // — multi-shop orders are verified per shop by each shop's financial staff.
  const orderTenantIds = Array.from(
    new Set(
      (order?.tenantIds && order.tenantIds.length > 0
        ? order.tenantIds
        : (order?.items ?? []).map((i) => {
            const p = i.product as { owner_id?: string; ownerId?: string };
            return p.owner_id ?? p.ownerId ?? '';
          })
      ).filter((id): id is string => !!id)
    )
  );
  const manualVerifyTenantId =
    order && canManualVerify
      ? isSuperAdmin
        ? orderTenantIds.length === 1
          ? orderTenantIds[0]
          : null
        : effectiveTenantId && orderTenantIds.includes(effectiveTenantId)
          ? effectiveTenantId
          : null
      : null;
  const manualVerifyVerification = manualVerifyTenantId
    ? verifications.find((v) => v.tenantId === manualVerifyTenantId)
    : undefined;

  // Single-order fallback fetch (see the fetchedOrder state above): direct
  // table read where the 064 SELECT policy allows it, the 070 scoped RPC
  // otherwise. Callable so changeItemStatus can re-run it after a status
  // update — the context optimistic update can't see a fallback-loaded order.
  const canReadOrdersTable = isSuperAdmin || !!capabilities?.financial;
  const loadFallbackOrder = useCallback(
    () => (canReadOrdersTable ? fetchOrderById(orderId) : fetchScopedOrder(orderId)),
    [canReadOrdersTable, orderId]
  );
  useEffect(() => {
    if (contextOrder || role === 'user') return;
    let cancelled = false;
    setFetchSettled(false);
    loadFallbackOrder()
      .then((result) => {
        if (!cancelled) setFetchedOrder(result);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFetchSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [contextOrder, role, loadFallbackOrder]);

  // Staff see only their shop's line items inside a mixed order, narrowed to
  // their branch when branch-scoped.
  const isStaffViewer = role === 'admin' && !!effectiveTenantId;

  // Unresolved payment-verification warnings (migration 056): admin viewers
  // only — shoppers never see them. Staff are scoped to their own shop, the
  // super admin sees every warned tenant. Unlike the verification section
  // this is not money-gated: branch staff process these orders too.
  const warningTenantId = isStaffViewer ? effectiveTenantId : null;
  const activePaymentWarnings: PaymentWarning[] = (() => {
    const warnings = order?.paymentWarnings;
    if (!order || !isAdminViewer || !warnings) return [];
    if (!hasPaymentWarning(order, warningTenantId)) return [];
    if (warningTenantId) return warnings[warningTenantId] ? [warnings[warningTenantId]] : [];
    return Object.keys(warnings)
      .filter((id) => hasPaymentWarning(order, id))
      .map((id) => warnings[id]);
  })();
  const visibleItems =
    order && isStaffViewer
      ? getOrderItemsForScope(
          order,
          effectiveTenantId,
          staffSession?.branchId,
          staffSession?.branchSelectionEnabled !== false
        )
      : order?.items;
  const visibleTotal =
    (visibleItems?.reduce((sum, item) => sum + getUnitPrice(item) * item.quantity, 0) ?? 0) +
    // Staff see what the shopper paid for their shop's slice, including the
    // shop's flat shipping fee (migration 031).
    (isStaffViewer && effectiveTenantId ? order?.shippingFees?.[effectiveTenantId] ?? 0 : 0);

  // Payment proofs are staff-only (migration 040): the super admin sees every
  // shop's proof, staff see only their own shop's. Refs are private-bucket
  // paths for new orders and full public URLs for legacy ones.
  const visibleProofRefs =
    order && canSeeProofs
      ? isStaffViewer
        ? Object.entries(order.paymentProofs ?? {})
            .filter(([ownerId]) => ownerId === effectiveTenantId)
            .map(([, ref]) => ref)
        : Object.values(order.paymentProofs ?? {})
      : [];

  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const openZoom = (url: string) => {
    setZoom(1);
    setZoomedImage(url);
  };
  const closeZoom = () => {
    setZoomedImage(null);
    setZoom(1);
  };
  // Web: mouse-wheel zoom on the viewer (react-native-web forwards a View's
  // ref to its DOM node).
  const zoomWheelRef = useCallback((node: unknown) => {
    if (Platform.OS !== 'web' || !node) return;
    const el = node as {
      addEventListener?: (
        type: string,
        listener: (e: { deltaY: number; preventDefault: () => void }) => void,
        options?: object
      ) => void;
    };
    if (typeof el.addEventListener !== 'function') return;
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + (e.deltaY < 0 ? 0.25 : -0.25))));
      },
      { passive: false }
    );
  }, []);
  const [proofUrls, setProofUrls] = useState<string[]>([]);
  const proofRefsKey = visibleProofRefs.join('|');

  // Paid digital downloads (migration 044), shopper view only: files of each
  // item whose status reached "Paid", revealed by sign-book-get.
  const [bookFiles, setBookFiles] = useState<Record<string, PurchasedBookFile[]>>({});
  const unlockKey =
    order && role === 'user'
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
            const files = await getPurchasedBookFiles(order.id, item.product.id, order.phoneNumber);
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

  // verify.et payment verification (financial staff only, migrations 040/045).
  // RLS scopes the read: a shop account receives only their shop's attempt,
  // the super admin receives every merchant's attempt on the order.
  useEffect(() => {
    if (!order || !canSeeVerification) return;
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
  }, [order?.id, canSeeVerification]);

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

  const saveManualReference = async (verification: PaymentVerification) => {
    if (!order) return;
    const reference = (manualRefs[verification.tenantId] ?? '').trim();
    const provider =
      manualProviders[verification.tenantId] ??
      (verification.provider === 'telebirr' ? 'telebirr' : 'cbe');
    if (!reference) {
      setVerifyError('Enter the transaction reference from the receipt.');
      return;
    }
    setManualBusy(true);
    setVerifyError('');
    setManualMessage('');
    try {
      await setOrderPaymentReference(order.id, verification.tenantId, provider, reference);
      setManualRefs((prev) => ({ ...prev, [verification.tenantId]: '' }));
      setManualMessage('Reference saved — this receipt is now marked as used.');
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : 'Could not save the reference.');
    } finally {
      setManualBusy(false);
    }
  };

  // Verify a manually typed reference against verify.et + the claims ledger
  // (financial staff / super admin; branch staff since 073, scoped to their
  // branch's items). On success the server has already recorded the
  // reference, claimed it, auto-paid the caller's scoped items and cleared
  // the warning when nothing remains open — here we only refresh what the
  // screen shows.
  const handleManualVerify = async () => {
    if (!order || !manualVerifyTenantId) return;
    const reference = manualVerifyRef.trim();
    if (!reference) {
      setManualVerifyReasons(['Enter the transaction reference from the receipt.']);
      return;
    }
    setManualVerifyBusy(true);
    setManualVerifyReasons([]);
    try {
      const result = await manualVerifyReference(
        order.id,
        manualVerifyTenantId,
        manualVerifyProvider,
        reference
      );
      if (!result.ok) {
        setManualVerifyReasons(result.reasons);
        return;
      }
      setManualVerifyRef('');
      notify(
        result.alreadyVerified
          ? 'This payment was already verified.'
          : manualVerifyScopeIsBranch
            ? "Payment verified — your branch's items are marked paid."
            : "Payment verified — the shop's items are marked paid.",
        'success'
      );
      // Refresh the verification chips immediately (the realtime subscription
      // also catches it); a fallback-loaded order refetches so the paid
      // status renders, context orders refresh via the orders subscription.
      fetchVerificationsForOrders([order.id]).then(setVerifications).catch(() => {});
      if (!contextOrder) {
        try {
          setFetchedOrder(await loadFallbackOrder());
        } catch {
          // The update landed; the stale copy refreshes on the next visit.
        }
      }
    } catch (error) {
      setManualVerifyReasons([
        error instanceof Error ? error.message : 'Verification failed. Please try again.',
      ]);
    } finally {
      setManualVerifyBusy(false);
    }
  };

  // Admins drive the status of each line item individually (per-item action
  // buttons under every item below); shoppers only see the read-only status.
  const changeItemStatus = async (
    itemKey: string,
    status: OrderStatus,
    cancelReason?: string,
    cancelDetail?: string
  ) => {
    if (!order) return;
    setStatusBusy(true);
    setStatusError('');
    try {
      await updateOrderItemStatus(order.id, itemKey, status, cancelReason, cancelDetail);
      // Fallback-loaded order (not in context): refetch so the new status
      // renders immediately — the context update can't see this copy.
      if (!contextOrder) {
        try {
          setFetchedOrder(await loadFallbackOrder());
        } catch {
          // The update landed; the stale copy refreshes on the next visit.
        }
      }
    } catch {
      setStatusError('Failed to update the item status. Please try again.');
    } finally {
      setStatusBusy(false);
    }
  };

  // Cancel-with-remark modal (072): cancelling a line requires a preset
  // reason; 'Other' requires the free-text detail. The server re-validates.
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [cancelDetail, setCancelDetail] = useState('');
  const cancelValid =
    !!cancelReason && (cancelReason !== 'Other' || cancelDetail.trim().length > 0);
  const openCancelModal = (itemKey: string) => {
    setCancelTarget(itemKey);
    setCancelReason(null);
    setCancelDetail('');
  };
  const confirmCancel = async () => {
    if (!cancelTarget || !cancelValid || !cancelReason) return;
    const target = cancelTarget;
    const reason = cancelReason;
    const detail = cancelReason === 'Other' ? cancelDetail.trim() : undefined;
    setCancelTarget(null);
    await changeItemStatus(target, 'cancelled', reason, detail);
  };

  // Forward transitions offered for one item, gated by the viewer's
  // capabilities (migration 045 — the server RPC enforces the same rules).
  // The super admin may perform every transition. 072: financial staff may
  // mark paid straight from pending, and a cancelled line can be restored to
  // pending by the same callers who may cancel it. 073: branch staff may
  // also mark THEIR scoped items paid (from pending or received).
  const statusActionsFor = (
    status: OrderStatus
  ): { target: OrderStatus; label: string; destructive?: boolean }[] => {
    const branch = isSuperAdmin || !!capabilities?.branch;
    const financial = isSuperAdmin || !!capabilities?.financial;
    const payer = financial || branch;
    const actions: { target: OrderStatus; label: string; destructive?: boolean }[] = [];
    if (status === 'pending') {
      if (branch) actions.push({ target: 'received', label: 'Mark Received' });
      if (payer) actions.push({ target: 'paid', label: 'Mark Paid' });
      if (branch) actions.push({ target: 'cancelled', label: 'Cancel Order', destructive: true });
    } else if (status === 'received') {
      if (payer) actions.push({ target: 'paid', label: 'Mark Paid' });
      if (branch) actions.push({ target: 'cancelled', label: 'Cancel Order', destructive: true });
    } else if (status === 'paid') {
      if (branch) actions.push({ target: 'on_the_way', label: 'Mark Shipped' });
    } else if (status === 'on_the_way') {
      if (branch) actions.push({ target: 'completed', label: 'Mark Completed' });
    } else if (status === 'cancelled') {
      if (branch) actions.push({ target: 'pending', label: 'Restore Order' });
    }
    return actions;
  };

  // Back always lands on the orders list: pop when this screen was reached
  // from it, otherwise (deep link / web refresh with no history — linking
  // config order/:orderId) navigate to the role's orders screen. The native
  // header back arrow and Telegram's BackButton already do exactly the
  // canGoBack branch — they only render when a screen below exists.
  const goBackToOrders = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else if (isAdminViewer) {
      navigation.navigate('AdminStack', { screen: 'AdminOrders' });
    } else {
      navigation.navigate('UserTabs', { screen: 'Orders' });
    }
  };

  if (!order) {
    return (
      <>
        {isWeb && header}
        <Screen>
          {notFoundReady && (role === 'user' || fetchSettled) ? (
            <EmptyState message="Order not found." icon="alert-circle-outline" />
          ) : (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          )}
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && header}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.container}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, isPhone && styles.titleCompact]}>Order Details</Text>
            {isWeb && (
              <TouchableOpacity style={styles.homeLink} onPress={goBackToOrders}>
                <Ionicons name="arrow-back" size={16} color={colors.primary} />
                <Text style={[styles.homeLinkText, isPhone && styles.homeLinkTextCompact]}>
                  {isAdminViewer ? 'Back' : 'Back to Orders'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.header}>
            <View>
              <Text style={styles.orderCode}>#{order.id}</Text>
              <Text style={styles.date}>
                {new Date(order.createdAt).toLocaleString()}
              </Text>
            </View>
            <OrderStatusBadge status={order.status} />
          </View>

          {activePaymentWarnings.length > 0 && (
            <View style={styles.warningBanner}>
              <View style={styles.warningBadges}>
                {activePaymentWarnings.map((warning, index) => (
                  <PaymentWarningBadge key={index} reason={warning.reason} />
                ))}
              </View>
              <Text style={styles.warningText}>
                Payment couldn't be confirmed automatically — check the proof before marking paid.
              </Text>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items</Text>
            {(visibleItems ?? []).map((item) => {
              const itemKey = getItemKey(item);
              const itemStatus = getItemStatus(order, item);
              // 072: cancelled lines show why (staff and shoppers alike).
              const cancelRemark =
                itemStatus === 'cancelled' ? order.cancelRemarks?.[itemKey] : undefined;
              const statusLabel = cancelRemark
                ? `${ORDER_STATUS_LABELS.cancelled} — ${cancelRemarkText(cancelRemark)}`
                : ORDER_STATUS_LABELS[itemStatus];
              return (
                <View key={itemKey} style={styles.itemBlock}>
                  <View style={styles.itemRow}>
                    <Text style={styles.itemName}>
                      {item.quantity} × {item.product.name}
                      {formatVariantLabel(item) ? ` (${formatVariantLabel(item)})` : ''}
                    </Text><View style={styles.itemRowEnd}>
                      {/* Line prices are money: hidden from staff without the
                          Financial capability (064 also zeroes them server-side). */}
                      {canSeeMoney && (
                        <Text style={styles.itemPrice}>
                          {formatPrice(getUnitPrice(item) * item.quantity)}
                        </Text>
                      )}
                      {/* Shopper ↔ shop DM about this specific item; admins
                          (super/tenant) don't get it. Prefer the snake_case
                          username stamped onto the snapshot at order time
                          (migration 025), same as owner_id/shop_name; fall
                          back to the camelCase field carried by locally-built
                          orders that haven't been re-read from the DB yet.
                          Items with neither (orders placed before 025, or a
                          shop with no username) render no button. */}
                      {role === 'user' && (
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
                    <View style={styles.statusActions}>
                      <Text style={styles.itemStatusLabel}>Status: {statusLabel}</Text>
                      {statusActionsFor(itemStatus).length > 0 && (
                        <View style={styles.statusChips}>
                          {statusActionsFor(itemStatus).map((action) => (
                            <TouchableOpacity
                              key={action.target}
                              style={[
                                styles.statusChip,
                                action.destructive && styles.statusChipDestructive,
                              ]}
                              disabled={statusBusy}
                              onPress={() =>
                                action.target === 'cancelled'
                                  ? openCancelModal(itemKey)
                                  : changeItemStatus(itemKey, action.target).catch(() => {})
                              }
                            >
                              <Text
                                style={[
                                  styles.statusChipText,
                                  action.destructive && styles.statusChipTextDestructive,
                                ]}
                              >
                                {action.label}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                    </View>
                  ) : (
                    <Text style={styles.itemStatusLabel}>Status: {statusLabel}</Text>
                  )}
                  {/* Paid digital downloads (migration 044) — shopper view;
                      only populated for items past "Paid". */}
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
            {isStaffViewer && visibleItems && visibleItems.length < order.items.length && (
              <Text style={styles.sharedHint}>
                Showing {visibleItems.length} of {order.items.length} items — only your shop's
                items are visible.
              </Text>
            )}
            {canSeeMoney && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalValue}>
                  {formatPrice(isStaffViewer ? visibleTotal : order.total)}
                </Text>
              </View>
            )}
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
            <Text style={styles.sectionTitle}>Delivery</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Location</Text>
              <Text style={styles.detailValue}>{order.location || 'Not provided'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Phone</Text>
              <Text style={styles.detailValue}>{order.phoneNumber || 'Not provided'}</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Payment</Text>
            <Text style={styles.paymentText}>Bank Transfer</Text>
            {proofUrls.length > 0 && (
              <View style={styles.proofGrid}>
                {proofUrls.map((url) => (
                  <TouchableOpacity key={url} onPress={() => openZoom(url)}>
                    <Image source={{ uri: url }} style={styles.proofThumb} resizeMode="cover" />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          {manualVerifyTenantId && manualVerifyVerification?.status !== 'verified' && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Verify payment manually</Text>
              <Text style={styles.verificationHint}>
                Type the transaction reference from the receipt — it is checked with the
                bank, and {manualVerifyScopeIsBranch ? "your branch's" : "the shop's"} items are
                marked paid when everything matches.
              </Text>
              <View style={styles.manualRefProviderRow}>
                {(['cbe', 'telebirr'] as const).map((p) => {
                  const active = manualVerifyProvider === p;
                  return (
                    <TouchableOpacity
                      key={p}
                      style={[styles.statusChip, active && styles.manualRefChipActive]}
                      onPress={() => setManualVerifyProvider(p)}
                    >
                      <Text
                        style={[
                          styles.statusChipText,
                          active && styles.manualRefChipTextActive,
                        ]}
                      >
                        {p === 'cbe' ? 'CBE' : 'Telebirr'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TextInput
                style={styles.manualRefInput}
                placeholder="Transaction reference from the receipt"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
                value={manualVerifyRef}
                onChangeText={setManualVerifyRef}
              />
              <View style={styles.verificationActions}>
                <Button title="Verify" loading={manualVerifyBusy} onPress={handleManualVerify} />
              </View>
              {manualVerifyReasons.map((reason, index) => (
                <Text key={index} style={styles.statusError}>
                  {reason}
                </Text>
              ))}
            </View>
          )}

          {canSeeVerification && verifications.length > 0 && (
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
                  {/* Manual reference entry (migration 067): only while this
                      shop's payment is still unconfirmed (warning showing) and
                      not already verified. Saved references are claimed
                      server-side — a receipt already used by another order is
                      rejected here and again when marking paid. */}
                  {hasPaymentWarning(order, verification.tenantId) &&
                    verification.status !== 'verified' && (
                      <View style={styles.manualRefBlock}>
                        <Text style={styles.manualRefTitle}>
                          Record reference manually
                        </Text>
                        {order.paymentReferences?.[verification.tenantId] && (
                          <Text style={styles.verificationMeta}>
                            Recorded: {order.paymentReferences[verification.tenantId].reference}
                            {' '}({order.paymentReferences[verification.tenantId].provider === 'telebirr'
                              ? 'Telebirr'
                              : 'CBE'})
                          </Text>
                        )}
                        <View style={styles.manualRefProviderRow}>
                          {(['cbe', 'telebirr'] as const).map((p) => {
                            const active =
                              (manualProviders[verification.tenantId] ??
                                (verification.provider === 'telebirr' ? 'telebirr' : 'cbe')) === p;
                            return (
                              <TouchableOpacity
                                key={p}
                                style={[styles.statusChip, active && styles.manualRefChipActive]}
                                onPress={() =>
                                  setManualProviders((prev) => ({
                                    ...prev,
                                    [verification.tenantId]: p,
                                  }))
                                }
                              >
                                <Text
                                  style={[
                                    styles.statusChipText,
                                    active && styles.manualRefChipTextActive,
                                  ]}
                                >
                                  {p === 'cbe' ? 'CBE' : 'Telebirr'}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                        <TextInput
                          style={styles.manualRefInput}
                          placeholder="Transaction reference from the receipt"
                          placeholderTextColor={colors.textSecondary}
                          autoCapitalize="characters"
                          autoCorrect={false}
                          value={manualRefs[verification.tenantId] ?? ''}
                          onChangeText={(text) =>
                            setManualRefs((prev) => ({ ...prev, [verification.tenantId]: text }))
                          }
                        />
                        <View style={styles.verificationActions}>
                          <Button
                            title="Save reference"
                            variant="outline"
                            loading={manualBusy}
                            onPress={() => saveManualReference(verification)}
                          />
                        </View>
                      </View>
                    )}
                </View>
              ))}
              {!!verifyError && <Text style={styles.statusError}>{verifyError}</Text>}
              {!!manualMessage && <Text style={styles.manualRefSuccess}>{manualMessage}</Text>}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Cancel with remark (072): a preset reason is required; picking
          'Other' requires the free-text detail. The server re-validates. */}
      <Modal
        visible={!!cancelTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setCancelTarget(null)}
      >
        <TouchableOpacity
          style={styles.cancelOverlay}
          activeOpacity={1}
          onPress={() => setCancelTarget(null)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.cancelCard} onPress={() => {}}>
            <Text style={styles.cancelTitle}>Cancel this item</Text>
            <Text style={styles.cancelHint}>Why is it being cancelled?</Text>
            <ScrollView style={styles.cancelReasonList}>
              {CANCEL_REASONS.map((reason) => {
                const active = cancelReason === reason;
                return (
                  <TouchableOpacity
                    key={reason}
                    style={styles.cancelReasonRow}
                    onPress={() => setCancelReason(reason)}
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={active ? colors.primary : colors.textSecondary}
                    />
                    <Text style={styles.cancelReasonText}>{reason}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {cancelReason === 'Other' && (
              <TextInput
                style={styles.manualRefInput}
                placeholder="Describe the reason"
                placeholderTextColor={colors.textSecondary}
                value={cancelDetail}
                onChangeText={setCancelDetail}
                multiline
                autoFocus
              />
            )}
            <View style={styles.cancelActions}>
              <Button title="Keep item" variant="outline" onPress={() => setCancelTarget(null)} />
              <Button
                title="Cancel item"
                variant="danger"
                loading={statusBusy}
                disabled={!cancelValid}
                onPress={() => confirmCancel().catch(() => {})}
              />
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Fullscreen payment proof zoom (072): step buttons 100%→400%, the
          ScrollView pans when zoomed, and the mouse wheel zooms on web.
          Tapping the image closes at 100% (a tap while inspecting a zoomed
          image must not dismiss it); the X always closes. */}
      <Modal
        visible={!!zoomedImage}
        transparent
        animationType="fade"
        onRequestClose={closeZoom}
      >
        <View style={styles.zoomOverlay} ref={zoomWheelRef}>
          <ScrollView
            style={styles.zoomScroll}
            contentContainerStyle={{
              width: windowWidth * zoom,
              height: windowHeight * zoom,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            directionalLockEnabled={false}
            bounces={false}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            <TouchableOpacity activeOpacity={1} disabled={zoom > 1} onPress={closeZoom}>
              {zoomedImage ? (
                <Image
                  source={{ uri: zoomedImage }}
                  style={{
                    width: windowWidth * 0.92 * zoom,
                    height: windowHeight * 0.8 * zoom,
                  }}
                  resizeMode="contain"
                />
              ) : null}
            </TouchableOpacity>
          </ScrollView>

          <TouchableOpacity style={styles.zoomCloseButton} onPress={closeZoom} hitSlop={12}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>

          <View style={styles.zoomControls}>
            <TouchableOpacity
              style={[styles.zoomButton, zoom <= ZOOM_MIN && styles.zoomButtonDisabled]}
              disabled={zoom <= ZOOM_MIN}
              onPress={() => setZoom((z) => Math.max(ZOOM_MIN, z - 0.5))}
            >
              <Ionicons name="remove" size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.zoomLevel}>{Math.round(zoom * 100)}%</Text>
            <TouchableOpacity
              style={[styles.zoomButton, zoom >= ZOOM_MAX && styles.zoomButtonDisabled]}
              disabled={zoom >= ZOOM_MAX}
              onPress={() => setZoom((z) => Math.min(ZOOM_MAX, z + 0.5))}
            >
              <Ionicons name="add" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
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
  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    maxWidth: pageWidth.form,
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
  warningBanner: {
    backgroundColor: colors.warning + '1A',
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: spacing.md,
    marginBottom: spacing.lg,
    gap: spacing.xs,
  },
  warningBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  warningText: {
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  orderCode: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
  },
  date: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  statusActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
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
  statusChipDestructive: {
    borderColor: colors.danger,
    backgroundColor: colors.danger,
  },
  statusChipText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  statusChipTextDestructive: {
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
  },
  zoomScroll: {
    flex: 1,
  },
  zoomCloseButton: {
    position: 'absolute',
    top: 48,
    left: 24,
    zIndex: 2,
  },
  zoomControls: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    zIndex: 2,
  },
  zoomButton: {
    padding: spacing.sm,
  },
  zoomButtonDisabled: {
    opacity: 0.35,
  },
  zoomLevel: {
    color: '#fff',
    fontSize: fontSizes.sm,
    fontWeight: '600',
    minWidth: 44,
    textAlign: 'center',
  },
  cancelOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  cancelCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    gap: spacing.sm,
  },
  cancelTitle: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.text,
  },
  cancelHint: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  cancelReasonList: {
    flexGrow: 0,
  },
  cancelReasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  cancelReasonText: {
    fontSize: fontSizes.md,
    color: colors.text,
  },
  cancelActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
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
    color: colors.text,
  },
  paymentText: {
    fontSize: fontSizes.md,
    color: colors.text,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  detailLabel: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  detailValue: {
    flex: 1,
    fontSize: fontSizes.md,
    color: colors.text,
    textAlign: 'right',
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
  manualRefBlock: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  manualRefTitle: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.text,
  },
  manualRefProviderRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  manualRefChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  manualRefChipTextActive: {
    color: colors.surface,
  },
  manualRefInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSizes.md,
    color: colors.text,
    backgroundColor: colors.background,
  },
  manualRefSuccess: {
    marginTop: spacing.md,
    fontSize: fontSizes.sm,
    color: colors.success,
  },
});
