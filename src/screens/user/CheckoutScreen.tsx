import { useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
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
import { Order, PaymentMethod } from '../../types';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';
import { isValidEthiopianPhoneNumber } from '../../utils/validation';

const MAX_WIDTH = 900;

export function CheckoutScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { cart, cartTotal, clearCart, addOrder } = useApp();
  const { isDesktop } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash_on_delivery');
  const [location, setLocation] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');

  const isWeb = Platform.OS === 'web';
  const phoneValid = isValidEthiopianPhoneNumber(phoneNumber);
  const showPhoneError = phoneTouched && phoneNumber.trim().length > 0 && !phoneValid;

  const canPlaceOrder =
    cart.length > 0 &&
    location.trim().length > 0 &&
    phoneValid &&
    (paymentMethod === 'cash_on_delivery' ||
      (cardNumber.length >= 12 && expiry.length >= 4 && cvv.length >= 3));

  async function handlePlaceOrder() {
    if (cart.length === 0) return;
    if (!phoneValid) {
      setPhoneTouched(true);
      Alert.alert('Invalid Phone Number', 'Please enter a valid Ethiopian phone number.');
      return;
    }

    const baseTime = Date.now();
    const orders: Order[] = cart.map((cartItem, index) => ({
      id: (baseTime + index).toString(),
      items: [cartItem],
      total: cartItem.product.price * cartItem.quantity,
      paymentMethod,
      status: paymentMethod === 'online_payment' ? 'paid' : 'pending',
      location: location.trim(),
      phoneNumber: phoneNumber.trim(),
      createdAt: new Date().toISOString(),
    }));

    try {
      await Promise.all(orders.map((order) => addOrder(order)));
      clearCart();
      navigation.navigate('UserTabs', { screen: 'Orders' });
      Alert.alert(
        'Order Placed',
        `Thank you! Your ${orders.length} order${orders.length > 1 ? 's' : ''} have been placed.`
      );
    } catch {
      Alert.alert('Error', 'Failed to place order. Please check your connection and try again.');
    }
  }

  function TouchableOption({
    label,
    selected,
    onPress,
  }: {
    label: string;
    selected: boolean;
    onPress: () => void;
  }) {
    return (
      <TouchableOpacity
        style={[styles.option, selected && styles.optionSelected]}
        onPress={onPress}
      >
        <View style={[styles.radio, selected && styles.radioSelected]} />
        <Text style={styles.optionText}>{label}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <>
      {isWeb && <WebHeader showSearch={false} />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.container}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>Checkout</Text>
            {isWeb && (
              <TouchableOpacity
                style={styles.homeLink}
                onPress={() => navigation.navigate('UserTabs', { screen: 'Home' })}
              >
                <Ionicons name="arrow-back" size={16} color={colors.primary} />
                <Text style={styles.homeLinkText}>Continue Shopping</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={[styles.columns, isDesktop && styles.columnsDesktop]}>
            <View style={styles.column}>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Order Summary</Text>
                {cart.map((item) => (
                  <View key={`${item.product.id}-${item.selectedImageIndex}`} style={styles.summaryRow}>
                    <Text style={styles.summaryText}>
                      {item.quantity} × {item.product.name}
                    </Text>
                    <Text style={styles.summaryText}>
                      ${(item.product.price * item.quantity).toFixed(2)}
                    </Text>
                  </View>
                ))}
                <View style={[styles.summaryRow, styles.totalRow]}>
                  <Text style={styles.totalText}>Total</Text>
                  <Text style={styles.totalText}>${cartTotal.toFixed(2)}</Text>
                </View>
              </View>
            </View>

            <View style={styles.column}>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Delivery Location</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter delivery location"
                  value={location}
                  onChangeText={setLocation}
                />

                <Text style={[styles.sectionTitle, styles.fieldGap]}>Phone Number</Text>
                <TextInput
                  style={[styles.input, showPhoneError && styles.inputError]}
                  placeholder="Enter phone number"
                  value={phoneNumber}
                  onChangeText={(text) => {
                    setPhoneNumber(text);
                    if (phoneTouched) setPhoneTouched(false);
                  }}
                  onBlur={() => setPhoneTouched(true)}
                  keyboardType="phone-pad"
                />
                {showPhoneError && (
                  <Text style={styles.errorText}>Enter a correct Ethiopian phone number</Text>
                )}
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Payment Method</Text>
                <TouchableOption
                  label="Cash on Delivery"
                  selected={paymentMethod === 'cash_on_delivery'}
                  onPress={() => setPaymentMethod('cash_on_delivery')}
                />
                <TouchableOption
                  label="Online Payment"
                  selected={paymentMethod === 'online_payment'}
                  onPress={() => setPaymentMethod('online_payment')}
                />
              </View>

              {paymentMethod === 'online_payment' && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Card Details</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Card number"
                    keyboardType="number-pad"
                    value={cardNumber}
                    onChangeText={setCardNumber}
                    maxLength={19}
                  />
                  <View style={styles.cardRow}>
                    <TextInput
                      style={[styles.input, styles.halfInput]}
                      placeholder="MM/YY"
                      keyboardType="number-pad"
                      value={expiry}
                      onChangeText={setExpiry}
                      maxLength={5}
                    />
                    <TextInput
                      style={[styles.input, styles.halfInput]}
                      placeholder="CVV"
                      keyboardType="number-pad"
                      value={cvv}
                      onChangeText={setCvv}
                      maxLength={4}
                      secureTextEntry
                    />
                  </View>
                </View>
              )}

              <Button
                title="Place Order"
                onPress={handlePlaceOrder}
                disabled={!canPlaceOrder}
                style={styles.placeButton}
              />
            </View>
          </View>
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
  columns: {
    gap: spacing.lg,
  },
  columnsDesktop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  column: {
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
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  optionSelected: {
    borderColor: colors.primary,
    backgroundColor: '#F0F7FF',
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
    marginRight: spacing.md,
  },
  radioSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  optionText: {
    fontSize: fontSizes.md,
    color: colors.text,
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
  },
  inputError: {
    borderColor: colors.danger,
  },
  errorText: {
    fontSize: fontSizes.sm,
    color: colors.danger,
    marginTop: spacing.xs,
  },
  cardRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  halfInput: {
    flex: 1,
  },
  placeButton: {
    marginTop: spacing.md,
  },
});
