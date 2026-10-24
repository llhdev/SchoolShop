import {
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Product } from '../types';
import { ProductImage } from './ProductImage';
import { getProductCoverImage } from '../utils/images';
import { formatPrice, getDiscountPercent } from '../utils/format';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

interface ProductCardProps {
  product: Product;
  onPress: () => void;
}

export function ProductCard({ product, onPress }: ProductCardProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const discount = product.priceHidden ? null : getDiscountPercent(product.price, product.compareAtPrice);
  // Free download posts (price 0, migration 044): no price.
  const isFreeDownload = !product.priceHidden && product.price === 0;

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
          {product.priceHidden ? (
            <Text style={styles.chatToOrder}>Chat to order</Text>
          ) : isFreeDownload ? (
            <Text style={styles.chatToOrder}>Free download</Text>
          ) : (
            <View style={styles.priceBlock}>
              {discount !== null && product.compareAtPrice && (
                <Text style={styles.compareAt} numberOfLines={1}>
                  {formatPrice(product.compareAtPrice)}
                </Text>
              )}
              <Text style={styles.price}>{formatPrice(product.price)}</Text>
            </View>
          )}
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
  chatToOrder: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  price: {
    fontSize: fontSizes.sm,
    fontWeight: '700',
    color: colors.price,
  },
});
