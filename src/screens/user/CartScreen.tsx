import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { CartItemRow } from '../../components/CartItemRow';
import { EmptyState } from '../../components/EmptyState';
import { Button } from '../../components/Button';
import { WebHeader } from '../../components/WebHeader';
import { useApp } from '../../context/AppContext';
import { formatPrice } from '../../utils/format';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 900;

export function CartScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { cart, cartTotal, cartCount, updateCartQuantity, removeFromCart } = useApp();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const isWeb = Platform.OS === 'web';

  if (cart.length === 0) {
    return (
      <>
        {isWeb && <WebHeader showSearch={false} />}
        <Screen>
          <EmptyState message="Your cart is empty." icon="cart-outline" />
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <WebHeader showSearch={false} />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Shopping Cart</Text>
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

        <FlatList
          data={cart}
          keyExtractor={(item) => `${item.product.id}-${item.selectedImageIndex}`}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <CartItemRow
              item={item}
              onIncrease={() =>
                updateCartQuantity(
                  item.product.id,
                  item.selectedImageIndex,
                  item.quantity + 1
                )
              }
              onDecrease={() =>
                updateCartQuantity(
                  item.product.id,
                  item.selectedImageIndex,
                  item.quantity - 1
                )
              }
              onRemove={() =>
                removeFromCart(item.product.id, item.selectedImageIndex)
              }
            />
          )}
        />
      </View>

      <View style={styles.footer}>
        <View style={styles.footerInner}>
          <View style={styles.row}>
            <Text style={styles.label}>Items</Text>
            <Text style={styles.value}>{cartCount}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatPrice(cartTotal)}</Text>
          </View>
          <Button
            title="Proceed to Checkout"
            onPress={() => navigation.navigate('Checkout')}
            style={styles.checkoutButton}
          />
        </View>
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
      paddingTop: spacing.md,
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
    list: {
      paddingBottom: Platform.OS === 'web' ? 24 : 200,
    },
    footer: {
      ...Platform.select({
        default: {
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
        },
        web: {
          position: 'relative',
        },
      }),
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    footerInner: {
      maxWidth: MAX_WIDTH,
      width: '100%',
      alignSelf: 'center',
      gap: 8,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    label: {
      fontSize: fontSizes.md,
      color: colors.textSecondary,
    },
    value: {
      fontSize: fontSizes.md,
      color: colors.text,
      fontWeight: '500',
    },
    totalLabel: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
    },
    totalValue: {
      fontSize: fontSizes.xl,
      fontWeight: '700',
      color: colors.primary,
    },
    checkoutButton: {
      marginTop: 8,
    },
  });
