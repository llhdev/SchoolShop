import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/Button';
import { WebHeader } from '../../components/WebHeader';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { RootStackParamList } from '../../types/navigation';
import { BankAccount, CartItem, Order, Product } from '../../types';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';
import { isValidEthiopianPhoneNumber } from '../../utils/validation';
import { generateOrderCode } from '../../utils/orderCode';
import { formatVariantLabel, getCartItemLineId, getUnitPrice } from '../../utils/variants';
import { missingRequiredAnswers } from '../../utils/checkoutFields';
import { formatPrice } from '../../utils/format';
import { resizeImage } from '../../utils/images';
import { uploadPaymentProof } from '../../services/images';
import { fetchProducts } from '../../services/products';
import {
  newVerificationKey,
  verifyPaymentReference,
} from '../../services/paymentVerificationCheckout';
import { fetchPaymentVerificationEnabled } from '../../services/settings';
import { LANDMARKS } from '../../constants/landmarks';
import {
  configureTelegramMainButton,
  hasTelegramChrome,
  isTelegramMiniApp,
  setTelegramMainButtonProgress,
  showTelegramPopup,
} from '../../lib/telegram';

const MAX_WIDTH = 900;
/** Cart items whose product has no owner (legacy seed rows) pay to the shop directly. */
const UNKNOWN_TENANT_KEY = 'unknown';

interface TenantPaymentGroup {
  key: string;
  shopName: string;
  bankAccounts: BankAccount[];
  /** Flat fee the shop charges once per order (0 = free). */
  shippingFee: number;
  /** The shop's own verification switch (profiles.payment_verification_enabled,
   *  migration 043); combined with the global kill-switch (042) to decide
   *  whether this shop's payment must be verified. */
  paymentVerificationEnabled: boolean;
  items: CartItem[];
  subtotal: number;
  /** What the shopper transfers to this shop: subtotal + shipping fee. */
  total: number;
}

/** Per-shop verification lifecycle: reading = OCR in progress (web);
 *  unverified = waiting for a reference / a Verify tap; the rest mirror the
 *  verify-payment-reference verdicts. */
type ShopVerifyState =
  | 'reading'
  | 'unverified'
  | 'verifying'
  | 'verified'
  | 'not_found'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'already_claimed'
  | 'unavailable';

interface ShopReference {
  provider?: 'cbe' | 'telebirr';
  reference: string;
  /** verify.et idempotency key — stable per (proof, reference text) so a
   *  retry of the same reference is billed for free. */
  key: string;
}

/** Verdicts that reject the payment outright: the shop stays blocked until
 *  the shopper pays correctly and picks a NEW proof image. */
const HARD_FAILURES: ShopVerifyState[] = ['wrong_recipient', 'wrong_amount', 'already_claimed'];

/** Status chip text per verification state. */
const VERIFY_CHIP_LABELS: Record<ShopVerifyState, string> = {
  reading: 'Reading…',
  unverified: 'Not verified',
  verifying: 'Verifying…',
  verified: 'Verified ✓',
  not_found: 'Not found',
  wrong_recipient: 'Wrong recipient',
  wrong_amount: 'Wrong amount',
  already_claimed: 'Already used',
  unavailable: 'Try again later',
};

export function CheckoutScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { cart, cartTotal, cartCount, clearCart, addOrder, shopper, products } = useApp();
  const { isDesktop, isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [location, setLocation] = useState('');
  const [landmarkPickerVisible, setLandmarkPickerVisible] = useState(false);
  const [landmarkQuery, setLandmarkQuery] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  /** Payment proof photo URLs, keyed by tenant owner id (one per shop in the cart). */
  const [proofsByTenant, setProofsByTenant] = useState<Record<string, string>>({});
  const [proofUploading, setProofUploading] = useState<Record<string, boolean>>({});
  /** Per-shop payment reference (auto-filled by OCR on web), keyed by the
   *  same tenant group key as proofsByTenant. */
  const [references, setReferences] = useState<Record<string, ShopReference>>({});
  const [verifyStates, setVerifyStates] = useState<Record<string, ShopVerifyState>>({});
  /** Amount the verifier saw on the receipt, for the wrong-amount message. */
  const [verifyPaidAmounts, setVerifyPaidAmounts] = useState<Record<string, number | null>>({});
  /** Latest verification key per group — a stale OCR/verify completion (from
   *  before a re-pick or edit) discards itself by comparing keys. */
  const verificationKeys = useRef<Record<string, string>>({});
  /** Answers to tenant-defined checkout questions, keyed by cart line id then
   *  question label. */
  const [answersByLine, setAnswersByLine] = useState<Record<string, Record<string, string>>>({});
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [placingOrder, setPlacingOrder] = useState(false);
  /** Fresh catalog fetched on mount. Cart items snapshot the product as it
   *  was when added, so bank accounts / shipping fee / shop name are resolved
   *  from the freshest data instead of the possibly stale cart snapshot. */
  const [freshProducts, setFreshProducts] = useState<Product[] | null>(null);
  /** Set when the shopper taps Place Order with required info missing: shows
   *  the guidance message once and marks every empty field in red. */
  const [showValidation, setShowValidation] = useState(false);
  /** Runtime kill-switch (platform_settings, migration 042): when off, the
   *  verification step is hidden and proofs alone satisfy each shop. Defaults
   *  to true until the flag read completes (fail toward verifying). */
  const [verificationEnabled, setVerificationEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchPaymentVerificationEnabled().then((enabled) => {
      if (!cancelled) setVerificationEnabled(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A tenant can publish bank details after the shopper's catalog was cached
  // (profile changes don't fire product realtime events), so re-fetch here.
  useEffect(() => {
    let cancelled = false;
    fetchProducts()
      .then((list) => {
        if (!cancelled) setFreshProducts(list);
      })
      .catch(() => {
        // Keep the context/catalog fallback below.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isWeb = Platform.OS === 'web';
  const isTMA = isTelegramMiniApp();
  const phoneValid = isValidEthiopianPhoneNumber(phoneNumber);
  const showPhoneError = phoneTouched && phoneNumber.trim().length > 0 && !phoneValid;

  // Payment is a direct bank transfer to each shop in the cart. Group the
  // cart by tenant so the shopper can transfer each shop's subtotal plus its
  // shipping fee and upload one payment proof per shop. Payment-relevant
  // fields (bank accounts, shipping fee, shop name, owner) always come from
  // the freshest catalog row — the cart snapshot may predate the tenant
  // publishing their bank details.
  const catalog = freshProducts ?? products;
  const tenantGroups = useMemo<TenantPaymentGroup[]>(() => {
    const map = new Map<string, TenantPaymentGroup>();
    for (const item of cart) {
      const current: Product =
        catalog.find((p) => p.id === item.product.id) ?? item.product;
      const key = current.ownerId ?? item.product.ownerId ?? UNKNOWN_TENANT_KEY;
      let group = map.get(key);
      if (!group) {
        const shippingFee = current.ownerShippingFee ?? 0;
        group = {
          key,
          shopName: current.shopName ?? item.product.shopName ?? 'Shop',
          bankAccounts: current.ownerBankAccounts ?? [],
          shippingFee,
          paymentVerificationEnabled: current.ownerPaymentVerificationEnabled ?? true,
          items: [],
          subtotal: 0,
          total: 0,
        };
        map.set(key, group);
      }
      group.items.push(item);
      group.subtotal += getUnitPrice(item) * item.quantity;
    }
    for (const group of map.values()) {
      group.total = group.subtotal + group.shippingFee;
    }
    return [...map.values()];
  }, [cart, catalog]);

  // Each shop in the cart charges its flat shipping fee once per order.
  const shippingTotal = tenantGroups.reduce((sum, group) => sum + group.shippingFee, 0);
  const orderTotal = cartTotal + shippingTotal;

  // Cart lines whose product defines tenant checkout questions (migration 036).
  // Field definitions come from the freshest catalog row, like bank details.
  const questionLines = useMemo(
    () =>
      cart
        .map((item) => {
          const current: Product =
            catalog.find((p) => p.id === item.product.id) ?? item.product;
          const fields = current.checkoutFields ?? item.product.checkoutFields ?? [];
          return fields.length > 0 ? { lineId: getCartItemLineId(item), item, fields } : null;
        })
        .filter((line): line is NonNullable<typeof line> => line !== null),
    [cart, catalog]
  );

  const unansweredRequired = questionLines.flatMap((line) =>
    missingRequiredAnswers(line.fields, answersByLine[line.lineId])
  );

  function setAnswer(lineId: string, label: string, value: string) {
    setAnswersByLine((prev) => ({
      ...prev,
      [lineId]: { ...prev[lineId], [label]: value },
    }));
  }

  const anyProofUploading = Object.values(proofUploading).some(Boolean);

  // A shop's payment must be verified only when BOTH the global kill-switch
  // (042) and the shop's own per-tenant flag (043) are on. Excluded shops are
  // satisfied by their proof photo alone (pre-040 behavior).
  const isGroupVerificationRequired = (group: TenantPaymentGroup) =>
    verificationEnabled && group.paymentVerificationEnabled;

  const canPlaceOrder =
    cart.length > 0 &&
    phoneValid &&
    unansweredRequired.length === 0 &&
    !placingOrder &&
    !anyProofUploading &&
    tenantGroups.length > 0 &&
    tenantGroups.every((group) => !!proofsByTenant[group.key]) &&
    tenantGroups.every(
      (group) =>
        !isGroupVerificationRequired(group) || verifyStates[group.key] === 'verified'
    );

  // Drop the red validation marks as soon as everything required is filled.
  useEffect(() => {
    if (showValidation && canPlaceOrder) setShowValidation(false);
  }, [showValidation, canPlaceOrder]);

  // Inside Telegram, the native MainButton replaces the in-app footer CTA.
  // useFocusEffect (not useEffect) so the button is hidden on blur: screens
  // below the top of the stack stay mounted, and an unmount-only cleanup
  // would leave the MainButton visible over Home/Orders.
  useFocusEffect(
    useCallback(() => {
      if (!isTMA) return;
      if (cart.length === 0) {
        configureTelegramMainButton(null);
        return;
      }
      configureTelegramMainButton({
        text: `Place Order — ${formatPrice(orderTotal)}`,
        // Telegram's disabled MainButton swallows taps, so keep it enabled and
        // signal "incomplete" with a gray color instead — tapping it then runs
        // handlePlaceOrder, which explains what's missing.
        color: canPlaceOrder ? colors.primary : colors.border,
        enabled: true,
        onPress: handlePlaceOrder,
      });
      return () => configureTelegramMainButton(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isTMA, canPlaceOrder, orderTotal, cart.length, colors.primary, colors.border])
  );

  /** Pick one payment proof photo for a shop and upload it right away, so the
   *  order can be placed without waiting on a network upload at submit time.
   *  Web uses a hidden file input; native uses expo-image-picker. */
  async function pickProof(groupKey: string) {
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
        quality: 0.8,
      });
      localUri = !result.canceled ? (result.assets[0]?.uri ?? null) : null;
    }
    if (!localUri) return;

    setProofUploading((prev) => ({ ...prev, [groupKey]: true }));
    try {
      const resized = await resizeImage(localUri, 800);
      const url = await uploadPaymentProof(resized);
      setProofsByTenant((prev) => ({ ...prev, [groupKey]: url }));
      // A new proof means a new payment: reset this shop's verification and
      // try to read the reference off the receipt. When verification is off
      // for this shop (global kill-switch or the shop's own flag), the proof
      // alone satisfies it.
      const group = tenantGroups.find((g) => g.key === groupKey);
      if (group && isGroupVerificationRequired(group)) {
        startVerification(groupKey, url, resized);
      } else {
        resetGroupVerification(groupKey);
      }
    } catch {
      Alert.alert('Upload Failed', 'Could not upload the payment proof. Please try again.');
    } finally {
      setProofUploading((prev) => ({ ...prev, [groupKey]: false }));
    }
  }

  /** Drop every piece of verification state for one shop (proof removed). */
  function resetGroupVerification(groupKey: string) {
    delete verificationKeys.current[groupKey];
    setReferences((prev) => {
      const next = { ...prev };
      delete next[groupKey];
      return next;
    });
    setVerifyStates((prev) => {
      const next = { ...prev };
      delete next[groupKey];
      return next;
    });
    setVerifyPaidAmounts((prev) => {
      const next = { ...prev };
      delete next[groupKey];
      return next;
    });
  }

  /** Reset one shop's verification for a freshly uploaded proof, then read
   *  the reference off the receipt with OCR. Web only — Tesseract.js needs a
   *  DOM/wasm — so native shoppers get the manual input directly. When OCR
   *  finds provider + reference, verification runs automatically. */
  function startVerification(groupKey: string, proofRef: string, imageUri: string) {
    const key = newVerificationKey();
    verificationKeys.current[groupKey] = key;
    setReferences((prev) => ({ ...prev, [groupKey]: { reference: '', key } }));
    setVerifyPaidAmounts((prev) => {
      const next = { ...prev };
      delete next[groupKey];
      return next;
    });

    if (Platform.OS !== 'web') {
      setVerifyStates((prev) => ({ ...prev, [groupKey]: 'unverified' }));
      return;
    }
    setVerifyStates((prev) => ({ ...prev, [groupKey]: 'reading' }));
    void (async () => {
      try {
        const { extractReceiptReference } = await import('../../lib/ocr');
        const ocr = await extractReceiptReference(imageUri);
        if (verificationKeys.current[groupKey] !== key) return;
        const next: ShopReference = {
          provider: ocr.provider,
          reference: ocr.reference ?? '',
          key,
        };
        setReferences((prev) => ({ ...prev, [groupKey]: next }));
        if (next.provider && next.reference) {
          void verifyShop(groupKey, proofRef, next);
        } else {
          setVerifyStates((prev) => ({ ...prev, [groupKey]: 'unverified' }));
        }
      } catch {
        if (verificationKeys.current[groupKey] !== key) return;
        setVerifyStates((prev) => ({ ...prev, [groupKey]: 'unverified' }));
      }
    })();
  }

  /** Verify one shop's reference against verify.et (pre-order, read-only)
   *  and map the verdict onto the shop's status chip. */
  async function verifyShop(groupKey: string, proofRef: string, ref: ShopReference) {
    if (!ref.provider || ref.reference.trim().length === 0) return;
    const group = tenantGroups.find((g) => g.key === groupKey);
    if (!group) return;
    setVerifyStates((prev) => ({ ...prev, [groupKey]: 'verifying' }));
    const result = await verifyPaymentReference({
      tenantId: groupKey,
      provider: ref.provider,
      reference: ref.reference.trim(),
      key: ref.key,
      proofRef,
      items: group.items.map((item) => ({
        productId: item.product.id,
        quantity: item.quantity,
        ...(item.selectedOptions && item.selectedOptions.length > 0
          ? { selectedOptions: item.selectedOptions }
          : {}),
      })),
    });
    // A re-pick or an edit superseded this attempt while it was in flight.
    if (verificationKeys.current[groupKey] !== ref.key) return;
    setVerifyStates((prev) => ({ ...prev, [groupKey]: result.verdict }));
    if (result.verdict === 'wrong_amount') {
      setVerifyPaidAmounts((prev) => ({ ...prev, [groupKey]: result.paidAmount }));
    }
  }

  /** Edit the (OCR-prefilled) reference. A changed text invalidates the old
   *  verification and gets a fresh idempotency key — verify.et bills per new
   *  key but replays same-key retries for free. */
  function editReference(groupKey: string, text: string) {
    setReferences((prev) => {
      const current = prev[groupKey];
      if (!current) return prev;
      if (text.trim() === current.reference) {
        return { ...prev, [groupKey]: { ...current, reference: text } };
      }
      const key = newVerificationKey();
      verificationKeys.current[groupKey] = key;
      return { ...prev, [groupKey]: { ...current, reference: text, key } };
    });
    setVerifyStates((prev) =>
      prev[groupKey] && prev[groupKey] !== 'unverified'
        ? { ...prev, [groupKey]: 'unverified' }
        : prev
    );
  }

  function setReferenceProvider(groupKey: string, provider: 'cbe' | 'telebirr') {
    setReferences((prev) => {
      const current = prev[groupKey];
      if (!current || current.provider === provider) return prev;
      // The provider is part of the verify.et request, so a changed provider
      // needs a fresh key just like a changed reference.
      const key = newVerificationKey();
      verificationKeys.current[groupKey] = key;
      return { ...prev, [groupKey]: { ...current, provider, key } };
    });
    setVerifyStates((prev) =>
      prev[groupKey] && prev[groupKey] !== 'unverified'
        ? { ...prev, [groupKey]: 'unverified' }
        : prev
    );
  }

  function copyAccountNumber(accountNumber: string) {
    if (Platform.OS === 'web') {
      // navigator.clipboard needs a secure context; fall back to an alert.
      const clipboard = (navigator as { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
      if (clipboard) {
        clipboard.writeText(accountNumber).catch(() => {});
      }
    }
    Alert.alert('Account Number', accountNumber);
  }

  async function handlePlaceOrder() {
    if (cart.length === 0 || placingOrder) return;
    if (!canPlaceOrder) {
      // Required info missing: mark the empty fields in red and tell the
      // shopper what's needed. The button stays tappable precisely so this
      // guidance can be shown.
      setPhoneTouched(true);
      setShowValidation(true);
      const allProofsUploaded = tenantGroups.every((group) => !!proofsByTenant[group.key]);
      const message =
        unansweredRequired.length > 0
          ? `Please answer the shop's questions: ${unansweredRequired.join(', ')}.`
          : allProofsUploaded && tenantGroups.some((g) => isGroupVerificationRequired(g))
            ? 'Payment verification is incomplete — verify each shop\'s payment before placing the order.'
            : 'Please fill in all required info: phone number and a payment proof for each shop.';
      if (!showTelegramPopup('Missing Information', message)) {
        Alert.alert('Missing Information', message);
      }
      return;
    }

    const order: Order = {
      id: generateOrderCode(),
      // Snapshot each line with the buyer's answers to the shop's questions.
      items: cart.map((item) => {
        const answers = answersByLine[getCartItemLineId(item)];
        const fieldAnswers = Object.entries(answers ?? {})
          .map(([label, value]) => ({ label, value: value.trim() }))
          .filter((a) => a.value.length > 0);
        return fieldAnswers.length > 0 ? { ...item, fieldAnswers } : item;
      }),
      total: orderTotal,
      paymentMethod: 'bank_transfer',
      status: 'pending',
      location: location.trim(),
      phoneNumber: phoneNumber.trim(),
      createdAt: new Date().toISOString(),
      telegramId: shopper?.telegramId,
      paymentProofs: proofsByTenant,
      // Every required group is verified at this point (canPlaceOrder), so
      // each has a provider + reference. The post-order verification replays
      // the same key, which verify.et does not bill. Shops whose verification
      // is off (global kill-switch or their own flag) get no reference — their
      // slice is skipped by verify-order-payment (043).
      paymentReferences: Object.fromEntries(
        tenantGroups.flatMap((group): [string, { provider: 'cbe' | 'telebirr'; reference: string; key: string }][] => {
          if (!isGroupVerificationRequired(group)) return [];
          const ref = references[group.key];
          return ref?.provider
            ? [[group.key, { provider: ref.provider, reference: ref.reference.trim(), key: ref.key }]]
            : [];
        })
      ),
      shippingFees: Object.fromEntries(
        tenantGroups
          .filter((group) => group.shippingFee > 0)
          .map((group) => [group.key, group.shippingFee])
      ),
    };

    setPlacingOrder(true);
    setTelegramMainButtonProgress(true);
    try {
      await addOrder(order);
      clearCart();
      // Leave Checkout so it isn't kept in the stack over Home/Orders.
      navigation.popToTop();
      navigation.navigate('UserTabs', { screen: 'Orders' });
      Alert.alert('Order Placed', 'Thank you! Your order has been placed.');
    } catch {
      Alert.alert('Error', 'Failed to place order. Please check your connection and try again.');
    } finally {
      setPlacingOrder(false);
      setTelegramMainButtonProgress(false);
    }
  }

  return (
    <>
      {isWeb && <WebHeader showSearch={false} />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.container}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, isPhone && styles.titleCompact]}>Checkout</Text>
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

          <View style={[styles.columns, isDesktop && styles.columnsDesktop]}>
            <View style={[styles.column, isDesktop && styles.columnDesktop]}>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Order Summary</Text>
                {cart.map((item) => (
                  <View key={getCartItemLineId(item)} style={styles.summaryRow}>
                    <Text style={styles.summaryText}>
                      {item.quantity} × {item.product.name}
                      {formatVariantLabel(item) ? ` (${formatVariantLabel(item)})` : ''}
                    </Text>
                    <Text style={styles.summaryText}>
                      {formatPrice(getUnitPrice(item) * item.quantity)}
                    </Text>
                  </View>
                ))}
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryText}>Shipping</Text>
                  {shippingTotal > 0 ? (
                    <Text style={styles.summaryText}>{formatPrice(shippingTotal)}</Text>
                  ) : (
                    <Text style={[styles.summaryText, styles.freeText]}>FREE</Text>
                  )}
                </View>
                <Text style={styles.estimateText}>Estimated delivery: 1–3 days</Text>
                <View style={[styles.summaryRow, styles.totalRow]}>
                  <Text style={styles.totalText}>Total</Text>
                  <Text style={styles.totalText}>{formatPrice(orderTotal)}</Text>
                </View>
              </View>
            </View>

            <View style={[styles.column, isDesktop && styles.columnDesktop]}>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>
                  Delivery Location <Text style={styles.optionalHint}>(optional)</Text>
                </Text>
                <TouchableOpacity
                  style={styles.landmarkButton}
                  onPress={() => {
                    setLandmarkQuery('');
                    setLandmarkPickerVisible(true);
                  }}
                >
                  <Ionicons name="location-outline" size={16} color={colors.primary} />
                  <Text style={styles.landmarkButtonText}>Choose a common location</Text>
                </TouchableOpacity>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. AAU Sidist Kilo Dorm, Block B"
                  value={location}
                  onChangeText={setLocation}
                />

                <Text style={[styles.sectionTitle, styles.fieldGap]}>Phone Number</Text>
                <TextInput
                  style={[
                    styles.input,
                    (showPhoneError || (showValidation && !phoneValid)) && styles.inputError,
                  ]}
                  placeholder="Enter phone number"
                  value={phoneNumber}
                  onChangeText={(text) => {
                    setPhoneNumber(text);
                    if (phoneTouched) setPhoneTouched(false);
                  }}
                  onBlur={() => setPhoneTouched(true)}
                  keyboardType="phone-pad"
                />
                {(showPhoneError || (showValidation && !phoneValid)) && (
                  <Text style={styles.errorText}>Enter a correct Ethiopian phone number</Text>
                )}
              </View>

              {questionLines.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Questions from the shop</Text>
                  {questionLines.map((line) => (
                    <View key={line.lineId} style={styles.questionCard}>
                      <Text style={styles.questionProduct}>
                        {line.item.product.name}
                        {formatVariantLabel(line.item)
                          ? ` (${formatVariantLabel(line.item)})`
                          : ''}
                      </Text>
                      {line.fields.map((field) => {
                        const value = answersByLine[line.lineId]?.[field.label] ?? '';
                        const missing =
                          showValidation && field.required && value.trim().length === 0;
                        return (
                          <View key={field.label} style={styles.questionField}>
                            <Text style={styles.questionLabel}>
                              {field.label}
                              {!field.required && (
                                <Text style={styles.optionalHint}> (optional)</Text>
                              )}
                            </Text>
                            {field.type === 'dropdown' ? (
                              <View style={styles.choiceRow}>
                                {(field.options ?? []).map((option) => (
                                  <TouchableOpacity
                                    key={option}
                                    style={[
                                      styles.choiceChip,
                                      value === option && styles.choiceChipActive,
                                      missing && styles.inputError,
                                    ]}
                                    onPress={() =>
                                      setAnswer(
                                        line.lineId,
                                        field.label,
                                        value === option ? '' : option
                                      )
                                    }
                                    activeOpacity={0.7}
                                  >
                                    <Text
                                      style={[
                                        styles.choiceChipText,
                                        value === option && styles.choiceChipTextActive,
                                      ]}
                                    >
                                      {option}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                            ) : (
                              <TextInput
                                style={[styles.input, missing && styles.inputError]}
                                placeholder={`Enter ${field.label.toLowerCase()}`}
                                value={value}
                                onChangeText={(text) =>
                                  setAnswer(line.lineId, field.label, text)
                                }
                              />
                            )}
                            {missing && (
                              <Text style={styles.errorText}>{field.label} is required</Text>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Bank Transfer</Text>
                <Text style={styles.paymentIntro}>
                  Pay each shop directly by bank transfer, then upload a photo of
                  your payment receipt for each shop. Your order is confirmed once
                  the shop verifies the transfer.
                </Text>
                {tenantGroups.map((group) => {
                  const proofUrl = proofsByTenant[group.key];
                  const uploading = !!proofUploading[group.key];
                  const proofMissing = showValidation && !proofUrl;
                  const reference = references[group.key];
                  const verifyState = verifyStates[group.key];
                  const hardFailed = !!verifyState && HARD_FAILURES.includes(verifyState);
                  const canVerify =
                    !!reference?.provider &&
                    reference.reference.trim().length > 0 &&
                    (verifyState === 'unverified' ||
                      verifyState === 'not_found' ||
                      verifyState === 'unavailable');
                  const paidAmount = verifyPaidAmounts[group.key];
                  const chip = verifyState ? VERIFY_CHIP_LABELS[verifyState] : undefined;
                  const chipColor =
                    verifyState === 'verified'
                      ? colors.success
                      : hardFailed
                        ? colors.danger
                        : colors.textSecondary;
                  return (
                    <View
                      key={group.key}
                      style={[styles.tenantCard, proofMissing && styles.tenantCardError]}
                    >
                      <View style={styles.tenantHeader}>
                        <Ionicons name="storefront-outline" size={16} color={colors.primary} />
                        <Text style={styles.tenantName}>{group.shopName}</Text>
                        <Text style={styles.tenantSubtotal}>{formatPrice(group.total)}</Text>
                      </View>

                      {group.items.map((item) => (
                        <View key={getCartItemLineId(item)} style={styles.tenantItemRow}>
                          <Text style={styles.tenantItemText}>
                            {item.quantity} × {item.product.name}
                            {formatVariantLabel(item) ? ` (${formatVariantLabel(item)})` : ''}
                          </Text>
                          <Text style={styles.tenantItemText}>
                            {formatPrice(getUnitPrice(item) * item.quantity)}
                          </Text>
                        </View>
                      ))}

                      {group.shippingFee > 0 && (
                        <View style={styles.tenantItemRow}>
                          <Text style={styles.tenantItemText}>Shipping</Text>
                          <Text style={styles.tenantItemText}>{formatPrice(group.shippingFee)}</Text>
                        </View>
                      )}

                      {group.bankAccounts.length > 0 ? (
                        group.bankAccounts.map((account, index) => (
                          <TouchableOpacity
                            key={`${account.accountNumber}-${index}`}
                            style={styles.accountRow}
                            onPress={() => copyAccountNumber(account.accountNumber)}
                            onLongPress={() => copyAccountNumber(account.accountNumber)}
                          >
                            <Ionicons name="card-outline" size={16} color={colors.textSecondary} />
                            <Text style={styles.accountNumber}>
                              {account.bankName ? `${account.bankName} — ${account.accountNumber}` : account.accountNumber}
                            </Text>
                            {isWeb && <Ionicons name="copy-outline" size={14} color={colors.textSecondary} />}
                          </TouchableOpacity>
                        ))
                      ) : (
                        <Text style={styles.bankMissing}>
                          This shop has not published bank details yet — contact them before paying.
                        </Text>
                      )}

                      {group.bankAccounts
                        .filter((account) => account.qrImageUrl)
                        .map((account, index) => (
                          <TouchableOpacity
                            key={`qr-${index}`}
                            onPress={() => setZoomedImage(account.qrImageUrl!)}
                          >
                            <Image
                              source={{ uri: account.qrImageUrl }}
                              style={styles.qrImage}
                              resizeMode="contain"
                            />
                            <Text style={styles.qrHint}>
                              {account.bankName ? `${account.bankName} — ` : ''}tap to enlarge the transfer QR code
                            </Text>
                          </TouchableOpacity>
                        ))}

                      {proofUrl ? (
                        <>
                          <View style={styles.proofRow}>
                            <Image source={{ uri: proofUrl }} style={styles.proofThumb} resizeMode="cover" />
                            <View style={styles.proofActions}>
                              <Text style={styles.proofOk}>Payment proof uploaded</Text>
                              <View style={styles.proofActionRow}>
                                <TouchableOpacity onPress={() => pickProof(group.key)} disabled={uploading}>
                                  <Text style={styles.proofReplace}>{uploading ? 'Uploading…' : 'Replace'}</Text>
                                </TouchableOpacity>
                                {chip && (
                                  <View style={[styles.verifyChip, { borderColor: chipColor }]}>
                                    <Text style={[styles.verifyChipText, { color: chipColor }]}>{chip}</Text>
                                  </View>
                                )}
                              </View>
                            </View>
                            <TouchableOpacity
                              onPress={() => {
                                setProofsByTenant((prev) => {
                                  const next = { ...prev };
                                  delete next[group.key];
                                  return next;
                                });
                                resetGroupVerification(group.key);
                              }}
                            >
                              <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                            </TouchableOpacity>
                          </View>

                          {isGroupVerificationRequired(group) && verifyState && verifyState !== 'reading' && (
                            <View style={styles.verifyBlock}>
                              {verifyState === 'unverified' && isWeb && !reference?.reference && (
                                <Text style={styles.verifyHint}>
                                  We couldn't read the receipt — upload a clearer screenshot or type
                                  the reference manually.
                                </Text>
                              )}
                              {verifyState === 'not_found' && (
                                <Text style={styles.verifyError}>
                                  We couldn't find this transaction — check the reference and retry.
                                </Text>
                              )}
                              {verifyState === 'wrong_recipient' && (
                                <Text style={styles.verifyError}>
                                  This payment went to a different account. Please pay the account
                                  shown and upload the new receipt.
                                </Text>
                              )}
                              {verifyState === 'wrong_amount' && (
                                <Text style={styles.verifyError}>
                                  This receipt is for{' '}
                                  {paidAmount != null ? formatPrice(paidAmount) : 'an unknown amount'}{' '}
                                  but this shop's total is {formatPrice(group.total)}.
                                </Text>
                              )}
                              {verifyState === 'already_claimed' && (
                                <Text style={styles.verifyError}>
                                  This transaction was already used for another order.
                                </Text>
                              )}
                              {verifyState === 'unavailable' && (
                                <Text style={styles.verifyHint}>
                                  Verification service is temporarily unavailable — please try again
                                  in a moment.
                                </Text>
                              )}

                              {/* Hard failures stay blocked until a new proof is
                                  picked, so the reference form hides for them. */}
                              {!hardFailed && (
                                <>
                                  <View style={styles.providerRow}>
                                    <Text style={styles.verifyLabel}>Paid via</Text>
                                    <View style={styles.choiceRow}>
                                      {(['cbe', 'telebirr'] as const).map((provider) => (
                                        <TouchableOpacity
                                          key={provider}
                                          style={[
                                            styles.choiceChip,
                                            reference?.provider === provider && styles.choiceChipActive,
                                          ]}
                                          onPress={() => setReferenceProvider(group.key, provider)}
                                          activeOpacity={0.7}
                                        >
                                          <Text
                                            style={[
                                              styles.choiceChipText,
                                              reference?.provider === provider &&
                                                styles.choiceChipTextActive,
                                            ]}
                                          >
                                            {provider === 'cbe' ? 'CBE' : 'Telebirr'}
                                          </Text>
                                        </TouchableOpacity>
                                      ))}
                                    </View>
                                  </View>
                                  <TextInput
                                    style={styles.input}
                                    placeholder="Transaction reference"
                                    value={reference?.reference ?? ''}
                                    onChangeText={(text) => editReference(group.key, text)}
                                    autoCapitalize="characters"
                                    autoCorrect={false}
                                  />
                                  {canVerify && (
                                    <Button
                                      title="Verify payment"
                                      variant="secondary"
                                      onPress={() => verifyShop(group.key, proofUrl, reference!)}
                                    />
                                  )}
                                </>
                              )}
                            </View>
                          )}
                        </>
                      ) : (
                        <>
                          <TouchableOpacity
                            style={[styles.proofButton, uploading && styles.proofButtonDisabled]}
                            onPress={() => pickProof(group.key)}
                            disabled={uploading}
                          >
                            <Ionicons
                              name={uploading ? 'hourglass-outline' : 'receipt-outline'}
                              size={16}
                              color={colors.primary}
                            />
                            <Text style={styles.proofButtonText}>
                              {uploading ? 'Uploading proof…' : 'Upload payment proof'}
                            </Text>
                          </TouchableOpacity>
                          {proofMissing && (
                            <Text style={styles.errorText}>
                              Upload the payment proof for {group.shopName}
                            </Text>
                          )}
                        </>
                      )}
                    </View>
                  );
                })}
              </View>

              <View style={styles.trustBlock}>
                <View style={styles.trustRow}>
                  <Ionicons name="shield-checkmark-outline" size={16} color={colors.success} />
                  <Text style={styles.trustText}>
                    7-day return on unused items — contact us to arrange a pickup.
                  </Text>
                </View>
                <View style={styles.trustRow}>
                  <Ionicons name="call-outline" size={16} color={colors.success} />
                  <Text style={styles.trustText}>
                    Questions? Call or message us on Telegram before you order.
                  </Text>
                </View>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* In the Mini App Telegram's native MainButton takes over — unless the
          SDK failed to load (stub mode), in which case the in-app button is
          the only way to place the order. */}
      {(!isTMA || !hasTelegramChrome()) && (
        <View style={styles.footer}>
          <View style={styles.footerInner}>
            <View style={styles.footerTotals}>
              <Text style={styles.footerCount}>
                {cartCount} item{cartCount === 1 ? '' : 's'}
              </Text>
              <Text style={styles.footerTotal}>{formatPrice(orderTotal)}</Text>
            </View>
            <Button
              title={placingOrder ? 'Placing Order…' : 'Place Order'}
              onPress={handlePlaceOrder}
              loading={placingOrder}
              style={[styles.footerButton, !canPlaceOrder && styles.footerButtonInactive]}
            />
          </View>
        </View>
      )}

      {/* Fullscreen QR zoom (bank transfer codes). */}
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

      <Modal
        animationType="fade"
        transparent
        visible={landmarkPickerVisible}
        onRequestClose={() => setLandmarkPickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.landmarkOverlay}
          activeOpacity={1}
          onPress={() => setLandmarkPickerVisible(false)}
        >
          <View style={styles.landmarkSheet}>
            <Text style={styles.landmarkTitle}>Common delivery locations</Text>
            <TextInput
              style={[styles.input, styles.landmarkSearch]}
              placeholder="Search (e.g. AAU, Bole, Merkato)"
              placeholderTextColor={colors.textSecondary}
              value={landmarkQuery}
              onChangeText={setLandmarkQuery}
              autoFocus
            />
            <ScrollView style={styles.landmarkList} keyboardShouldPersistTaps="handled">
              {LANDMARKS.filter((landmark) =>
                landmark.toLowerCase().includes(landmarkQuery.trim().toLowerCase())
              ).map((landmark) => (
                <TouchableOpacity
                  key={landmark}
                  style={styles.landmarkItem}
                  onPress={() => {
                    setLocation(landmark);
                    setLandmarkPickerVisible(false);
                  }}
                >
                  <Text style={styles.landmarkItemText}>{landmark}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
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
    paddingBottom: 120,
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
  columns: {
    // Mobile: columns stack, so the section marginBottom alone controls the
    // gap — a column gap here would double it between summary and delivery.
    gap: 0,
  },
  columnsDesktop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.lg,
  },
  column: {
    // On mobile the columns stack; without an explicit width the section
    // cards would only be as wide as their content.
    width: '100%',
  },
  columnDesktop: {
    // Only on the side-by-side desktop layout should the columns share the
    // row equally — flex: 1 in the stacked (mobile) direction makes each
    // column grow and leaves a huge gap between sections.
    flex: 1,
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
  fieldGap: {
    marginTop: spacing.lg,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  summaryText: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
  },
  totalText: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.text,
  },
  freeText: {
    color: colors.success,
    fontWeight: '700',
  },
  estimateText: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  paymentIntro: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  tenantCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  tenantCardError: {
    borderColor: colors.danger,
  },
  tenantHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  tenantName: {
    flex: 1,
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
  },
  tenantSubtotal: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.primary,
  },
  tenantItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tenantItemText: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.background,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  accountNumber: {
    flex: 1,
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: 0.5,
  },
  bankMissing: {
    fontSize: fontSizes.sm,
    color: colors.danger,
  },
  qrImage: {
    width: 120,
    height: 120,
    alignSelf: 'center',
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
  },
  qrHint: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  proofButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
  },
  proofButtonDisabled: {
    opacity: 0.6,
  },
  proofButtonText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.primary,
  },
  proofRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  proofThumb: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
  },
  proofActions: {
    flex: 1,
    gap: 2,
  },
  proofOk: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.success,
  },
  proofReplace: {
    fontSize: fontSizes.sm,
    color: colors.primary,
    fontWeight: '600',
  },
  proofActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  verifyChip: {
    borderWidth: 1,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  verifyChipText: {
    fontSize: fontSizes.xs,
    fontWeight: '600',
  },
  verifyBlock: {
    gap: spacing.sm,
  },
  verifyHint: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  verifyError: {
    fontSize: fontSizes.sm,
    color: colors.danger,
  },
  verifyLabel: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.text,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
    height: '70%',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSizes.md,
    backgroundColor: colors.background,
    color: colors.text,
    // Web draws a focus outline on the inner <input> that doubles the
    // container border — suppress it so the field reads as one box.
    ...(Platform.OS === 'web'
      ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
      : {}),
  },
  landmarkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  landmarkButtonText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.primary,
  },
  landmarkOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  landmarkSheet: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    maxHeight: '80%',
  },
  landmarkTitle: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  landmarkSearch: {
    marginBottom: spacing.sm,
  },
  landmarkList: {
    flexGrow: 0,
  },
  landmarkItem: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  landmarkItemText: {
    fontSize: fontSizes.md,
    color: colors.text,
  },
  inputError: {
    borderColor: colors.danger,
  },
  questionCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  questionProduct: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  questionField: {
    marginTop: spacing.sm,
  },
  questionLabel: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  choiceChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  choiceChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  choiceChipText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.text,
  },
  choiceChipTextActive: {
    color: colors.surface,
  },
  optionalHint: {
    fontSize: fontSizes.sm,
    fontWeight: '400',
    color: colors.textSecondary,
  },
  errorText: {
    fontSize: fontSizes.sm,
    color: colors.danger,
    marginTop: spacing.xs,
  },
  trustBlock: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  trustText: {
    flex: 1,
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  footerInner: {
    maxWidth: MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  footerTotals: {
    flexShrink: 0,
  },
  footerCount: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  footerTotal: {
    fontSize: fontSizes.xl,
    fontWeight: '700',
    color: colors.text,
  },
  footerButton: {
    flex: 1,
  },
  footerButtonInactive: {
    opacity: 0.5,
  },
});
