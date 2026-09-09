import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { WebHeader } from '../../components/WebHeader';
import { TelegramAccountBadge } from '../../components/TelegramAccountBadge';
import { ProductImage } from '../../components/ProductImage';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { formatPrice } from '../../utils/format';
import { getProductCoverImage } from '../../utils/images';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 900;

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

  if (orders.length === 0) {
    return (
      <>
        {isWeb && <WebHeader showSearch={false} />}
        <Screen>
          <View style={styles.container}>
            {accountBadge}
            <EmptyState message="No orders yet." icon="receipt-outline" />
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

        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => navigation.navigate('OrderDetail', { orderId: item.id })}
            >
              <View style={styles.orderHeader}>
                <Text style={styles.date}>
                  {new Date(item.createdAt).toLocaleDateString()}
                </Text>
                <View style={styles.headerRight}>
                  <View
                    style={[
                      styles.badge,
                      item.status === 'paid' && styles.paidBadge,
                      item.status === 'pending' && styles.pendingBadge,
                      item.status === 'delivered' && styles.deliveredBadge,
                      item.status === 'completed' && styles.completedBadge,
                      item.status === 'failed' && styles.failedBadge,
                    ]}
                  >
                    <Text style={styles.badgeText}>{item.status}</Text>
                  </View>
                  <Text style={styles.price}>{formatPrice(item.total)}</Text>
                </View>
              </View>

              {item.items.map((i) => (
                <View
                  key={`${i.product.id}-${i.selectedImageIndex}`}
                  style={styles.itemRow}
                >
                  <View style={styles.itemThumb}>
                    <ProductImage
                      uri={getProductCoverImage(i.product)}
                      category={i.product.category}
                      name={i.product.name}
                      thumbnail
                      style={styles.itemThumbImage}
                    />
                  </View>
                  <Text style={styles.itemName} numberOfLines={1}>
                    {i.quantity} × {i.product.name}
                  </Text>
                  <Text style={styles.itemPrice}>
                    {formatPrice(i.product.price * i.quantity)}
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
    maxWidth: MAX_WIDTH,
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
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
    fontWeight: '600',
    color: colors.text,
  },
  price: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.primary,
  },
  date: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
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
});
