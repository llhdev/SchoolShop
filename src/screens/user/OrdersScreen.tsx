import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { OrderStatusBadge } from '../../components/OrderStatusBadge';
import { WebHeader } from '../../components/WebHeader';
import { TelegramAccountBadge } from '../../components/TelegramAccountBadge';
import { ProductImage } from '../../components/ProductImage';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { formatVariantLabel, getUnitPrice } from '../../utils/variants';
import { getProductCoverImage } from '../../utils/images';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, pageWidth, ColorPalette } from '../../constants/theme';

export function OrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { orders, shopper } = useApp();
  const { isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const accountBadge = shopper ? (
    <View style={styles.badgeWrap}>
      <TelegramAccountBadge shopper={shopper} />
    </View>
  ) : null;

  const isWeb = Platform.OS === 'web';
  const goHome = () => navigation.navigate('UserTabs', { screen: 'Home' });

  if (orders.length === 0) {
    return (
      <>
        {isWeb && <WebHeader showSearch={false} />}
        <Screen>
          <View style={styles.container}>
            {accountBadge}
            <EmptyState
              message="No orders yet."
              icon="receipt-outline"
              actionLabel="Browse products"
              onAction={goHome}
            />
          </View>
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <WebHeader showSearch={false} />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
        {accountBadge}
        <View style={styles.titleRow}>
          <Text style={[styles.title, isPhone && styles.titleCompact]}>My Orders</Text>
          {isWeb && (
            <TouchableOpacity style={styles.homeLink} onPress={goHome}>
              <Ionicons name="arrow-back" size={16} color={colors.primary} />
              <Text style={[styles.homeLinkText, isPhone && styles.homeLinkTextCompact]}>
                Continue Shopping
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* One card per order: code + date + status on the header, the order's
            line items grouped below it. */}
        <FlatList
          data={orders}
          keyExtractor={(order) => order.id}
          renderItem={({ item: order }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => navigation.navigate('OrderDetail', { orderId: order.id })}
            >
              <View style={styles.orderHeader}>
                <View style={styles.orderHeaderText}>
                  <Text style={styles.orderCode}>#{order.id}</Text>
                  <Text style={styles.date}>
                    {new Date(order.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <View style={styles.headerRight}>
                  <OrderStatusBadge status={order.status} small />
                  <Text style={styles.total}>{formatPrice(order.total)}</Text>
                </View>
              </View>

              {order.items.map((item, index) => (
                <View
                  key={`${item.product.id}:${item.selectedImageIndex}:${index}`}
                  style={styles.itemRow}
                >
                  <View style={styles.itemThumb}>
                    <ProductImage
                      uri={getProductCoverImage(item.product)}
                      category={item.product.category}
                      name={item.product.name}
                      thumbnail
                      style={styles.itemThumbImage}
                    />
                  </View>
                  <Text style={styles.itemName} numberOfLines={1}>
                    {item.quantity} × {item.product.name}
                    {formatVariantLabel(item) ? ` (${formatVariantLabel(item)})` : ''}
                  </Text>
                  <Text style={styles.itemPrice}>
                    {formatPrice(getUnitPrice(item) * item.quantity)}
                  </Text>
                </View>
              ))}
            </TouchableOpacity>
          )}
        />
      </View>
    </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  container: {
    flex: 1,
    maxWidth: pageWidth.form,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
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
  badgeWrap: {
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...(Platform.OS === 'web'
      ? ({
          cursor: 'pointer',
        } as any)
      : {}),
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  orderHeaderText: {
    flex: 1,
    gap: 2,
  },
  orderCode: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
  },
  date: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  total: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    gap: spacing.sm,
  },
  itemThumb: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  itemThumbImage: {
    width: '100%',
    height: '100%',
  },
  itemName: {
    flex: 1,
    fontSize: fontSizes.sm,
    fontWeight: '500',
    color: colors.text,
  },
  itemPrice: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
});
