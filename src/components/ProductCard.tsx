import {
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Product } from '../types';
import { ProductImage } from './ProductImage';
import { getProductCoverImage } from '../utils/images';
import { formatPrice, getDiscountPercent } from '../utils/format';
import { useApp } from '../context/AppContext';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

interface ProductCardProps {
  product: Product;
  onPress: () => void;
}

export function ProductCard({ product, onPress }: ProductCardProps) {
  const { cart, addToCart, updateCartQuantity } = useApp();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const coverIndex = product.coverImageIndex ?? 0;
  const discount = getDiscountPercent(product.price, product.compareAtPrice);

  const cartQuantity = cart
    .filter((item) => item.product.id === product.id)
    .reduce((sum, item) => sum + item.quantity, 0);

  const coverItem = cart.find(
    (item) =>
      item.product.id === product.id && item.selectedImageIndex === coverIndex
  );

  function handleAdd() {
    addToCart(product, coverIndex);
  }

  function handleDecrease() {
    if (coverItem) {
      updateCartQuantity(product.id, coverIndex, coverItem.quantity - 1);
    }
  }

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.9}
    >
      <View style={styles.imageContainer}>
        <ProductImage
          uri={getProductCoverImage(product)}
          category={product.category}
          name={product.name}
          thumbnail
          style={styles.image}
        />
        {discount !== null && (
          <View style={styles.discountBadge}>
            <Text style={styles.discountBadgeText}>-{discount}%</Text>
          </View>
        )}
      </View>
      <View style={styles.content}>
        <Text style={styles.name} numberOfLines={1}>
          {product.name}
        </Text>
        {product.shopName ? (
          <Text style={styles.shopName} numberOfLines={1}>
            {product.shopName}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <View style={styles.priceBlock}>
            {discount !== null && product.compareAtPrice && (
              <Text style={styles.compareAt} numberOfLines={1}>
                {formatPrice(product.compareAtPrice)}
              </Text>
            )}
            <Text style={styles.price}>{formatPrice(product.price)}</Text>
          </View>
          <View style={styles.actions}>
            {cartQuantity > 0 && (
              <TouchableOpacity
                style={styles.qtyButton}
                onPress={handleDecrease}
                activeOpacity={0.8}
              >
                <Ionicons name="remove" size={16} color={colors.primary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.addButton}
              onPress={handleAdd}
              activeOpacity={0.8}
            >
              <Ionicons name="add" size={18} color={colors.primary} />
              {cartQuantity > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {cartQuantity > 99 ? '99+' : cartQuantity}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    margin: spacing.xs,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
    ...(Platform.OS === 'web'
      ? ({
          cursor: 'pointer',
          transition: 'transform 0.15s ease, box-shadow 0.15s ease',
        } as any)
      : {}),
  },
  imageContainer: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: colors.background,
  },
  discountBadge: {
    position: 'absolute',
    top: spacing.xs,
    left: spacing.xs,
    backgroundColor: colors.price,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  discountBadgeText: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '700',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  content: {
    padding: spacing.sm,
    gap: 2,
  },
  name: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.text,
  },
  shopName: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  priceBlock: {
    flex: 1,
    marginRight: spacing.xs,
  },
  compareAt: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  price: {
    fontSize: fontSizes.sm,
    fontWeight: '700',
    color: colors.price,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  qtyButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: colors.price,
    borderRadius: 9,
    minWidth: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: colors.surface,
    fontSize: 10,
    fontWeight: '700',
  },
});
