import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Dimensions,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ProductImage } from '../../components/ProductImage';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { getProductGalleryImages } from '../../utils/images';
import { isTelegramMiniApp } from '../../lib/telegram';
import { formatPrice, getDiscountPercent } from '../../utils/format';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const PHONE_IMAGE_HEIGHT_RATIO = 0.65;
const MAX_WIDTH = 1200;

export function ProductDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { productId } = route.params as { productId: string };
  const { products, addToCart } = useApp();
  const { isDesktop } = useResponsive();
  const { width: windowWidth } = useWindowDimensions();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [activeIndex, setActiveIndex] = useState(0);
  const [justAdded, setJustAdded] = useState(false);
  const addResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTMA = isTelegramMiniApp();

  const product = products.find((p) => p.id === productId);

  if (!product) {
    return (
      <Screen>
        <EmptyState message="Product not found." icon="alert-circle-outline" />
      </Screen>
    );
  }

  const galleryImages = useMemo(() => getProductGalleryImages(product), [product]);
  const discount = getDiscountPercent(product.price, product.compareAtPrice);
  const isWebDesktop = Platform.OS === 'web' && isDesktop;

  useEffect(
    () => () => {
      if (addResetTimer.current) clearTimeout(addResetTimer.current);
    },
    []
  );

  function handleAddToCart() {
    if (!product) return;
    addToCart(product, activeIndex);
    if (isTMA) {
      // Same confirmation mark the card's quick-add shows: a brief check
      // state on the button instead of leaving the page.
      setJustAdded(true);
      if (addResetTimer.current) clearTimeout(addResetTimer.current);
      addResetTimer.current = setTimeout(() => setJustAdded(false), 1600);
    } else {
      navigation.goBack();
    }
  }

  function handleBuy() {
    if (!product) return;
    addToCart(product, activeIndex);
    navigation.navigate('Checkout');
  }

  const phoneImageHeight = windowWidth * PHONE_IMAGE_HEIGHT_RATIO;

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const index = Math.round(event.nativeEvent.contentOffset.x / windowWidth);
    const clamped = Math.min(Math.max(index, 0), galleryImages.length - 1);
    // onScroll fires continuously during a swipe; only update when the
    // active page actually changes. onMomentumScrollEnd alone is unreliable
    // in react-native-web inside the Telegram WebView, which is why the dots
    // used to freeze after sliding.
    setActiveIndex((prev) => (prev === clamped ? prev : clamped));
  }

  const infoSection = (
    <View style={styles.info}>
      {isTMA ? (
        // Mini App: clean stacked layout — smaller, lighter product name on
        // its own line, then a single price row.
        <>
          <Text style={styles.tmaName} numberOfLines={2}>
            {product.name}
          </Text>
          <View style={styles.tmaPriceRow}>
            <Text style={styles.tmaPrice}>{formatPrice(product.price)}</Text>
            {discount !== null && product.compareAtPrice && (
              <Text style={styles.compareAt}>{formatPrice(product.compareAtPrice)}</Text>
            )}
            {discount !== null && (
              <Text style={styles.discountTag}>Save {discount}%</Text>
            )}
          </View>
        </>
      ) : (
        <View style={styles.headerRow}>
          <Text style={styles.name} numberOfLines={2}>
            {product.name}
          </Text>
          <View style={styles.priceBlock}>
            {discount !== null && product.compareAtPrice && (
              <Text style={styles.compareAt}>{formatPrice(product.compareAtPrice)}</Text>
            )}
            <Text style={styles.price}>{formatPrice(product.price)}</Text>
            {discount !== null && (
              <Text style={styles.discountTag}>Save {discount}%</Text>
            )}
          </View>
        </View>
      )}

      {product.shopName ? (
        <Text style={styles.shopName} numberOfLines={1}>
          {product.shopName}
        </Text>
      ) : null}

      <View style={styles.metaRow}>
        <Text style={styles.category}>{product.category}</Text>
      </View>

      <View style={styles.divider} />

      {!isTMA && (
        <View style={styles.actions}>
          <Button
            title="Add to Cart"
            onPress={handleAddToCart}
            style={styles.actionButton}
          />
        </View>
      )}

      {product.description.length > 0 && (
        <>
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>Description</Text>
          <Text style={styles.description}>{product.description}</Text>
        </>
      )}
    </View>
  );

  if (isWebDesktop) {
    return (
      <Screen noPadding edges={['top', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.desktopScroll}>
          <View style={styles.desktopInner}>
            <View style={styles.desktopGallery}>
              <View style={styles.desktopMainImage}>
                <ProductImage
                  uri={galleryImages[activeIndex] ?? null}
                  category={product.category}
                  name={product.name}
                  style={styles.desktopImage}
                />
              </View>
              {galleryImages.length > 1 && (
                <View style={styles.thumbnailRow}>
                  {galleryImages.map((uri, index) => (
                    <TouchableOpacity
                      key={index}
                      style={[
                        styles.thumbnailButton,
                        index === activeIndex && styles.thumbnailButtonActive,
                      ]}
                      onPress={() => setActiveIndex(index)}
                    >
                      <ProductImage
                        uri={uri}
                        category={product.category}
                        name={product.name}
                        style={styles.thumbnailImage}
                        contentFit="cover"
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
            {infoSection}
          </View>
        </ScrollView>
      </Screen>
    );
  }

  const gallerySection = (
    <View style={[styles.galleryContainer, { height: phoneImageHeight }]}>
      <FlatList
        data={galleryImages}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        snapToInterval={windowWidth}
        decelerationRate="fast"
        bounces={false}
        keyExtractor={(_, index) => `gallery-${index}`}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        onMomentumScrollEnd={handleScroll}
        renderItem={({ item }) => (
          <View style={[styles.imageSlide, { width: windowWidth, height: phoneImageHeight }]}>
            <ProductImage
              uri={item}
              category={product.category}
              name={product.name}
              style={styles.image}
            />
          </View>
        )}
        getItemLayout={(_, index) => ({
          length: windowWidth,
          offset: windowWidth * index,
          index,
        })}
      />
      {galleryImages.length > 1 && (
        <View style={styles.dots}>
          {galleryImages.map((_, index) => (
            <View
              key={index}
              style={[styles.dot, index === activeIndex && styles.activeDot]}
            />
          ))}
        </View>
      )}
    </View>
  );

  if (isTMA) {
    // Mini App: full-screen page with a fixed bottom action bar. Screen is
    // non-scroll here so the bar stays put; the page content scrolls inside.
    return (
      <Screen noPadding edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.tmaContainer}>
          <ScrollView
            style={styles.tmaScroll}
            contentContainerStyle={styles.tmaScrollContent}
          >
            {gallerySection}
            {infoSection}
          </ScrollView>
          <View style={styles.tmaBottomBar}>
            <Button
              title={justAdded ? '✓ Added to Cart' : 'Add to Cart'}
              variant="outline"
              onPress={handleAddToCart}
              style={styles.tmaBarButton}
            />
            <Button title="Buy" onPress={handleBuy} style={styles.tmaBarButton} />
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll noPadding edges={['top', 'left', 'right']}>
      {gallerySection}
      {infoSection}
    </Screen>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  desktopScroll: {
    flexGrow: 1,
    backgroundColor: colors.surface,
  },
  desktopInner: {
    flex: 1,
    flexDirection: 'row',
    maxWidth: MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
  },
  desktopGallery: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  desktopMainImage: {
    flex: 1,
    minHeight: 420,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  desktopImage: {
    width: '100%',
    height: '100%',
  },
  thumbnailRow: {
    flexDirection: 'row',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  thumbnailButton: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'border-color 0.15s ease',
      } as any,
    }),
  },
  thumbnailButtonActive: {
    borderColor: colors.primary,
    borderWidth: 3,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  galleryContainer: {
    width: '100%',
    backgroundColor: colors.surface,
    marginBottom: spacing.lg,
  },
  imageSlide: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  dots: {
    position: 'absolute',
    bottom: spacing.md,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  activeDot: {
    backgroundColor: colors.primary,
    width: 18,
    height: 8,
    borderRadius: 4,
  },
  info: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    justifyContent: 'flex-start',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  name: {
    flex: 1,
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  priceBlock: {
    alignItems: 'flex-end',
  },
  compareAt: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  discountTag: {
    fontSize: fontSizes.xs,
    fontWeight: '700',
    color: colors.price,
    marginTop: 2,
  },
  price: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.price,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  category: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
  },
  shopName: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  sectionTitle: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  description: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
    lineHeight: 24,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  actionButton: {
    flex: 1,
    maxWidth: 220,
  },
  tmaContainer: {
    flex: 1,
  },
  tmaName: {
    fontSize: fontSizes.lg,
    fontWeight: '600',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  tmaPriceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  tmaPrice: {
    fontSize: fontSizes.xl,
    fontWeight: '700',
    color: colors.price,
  },
  tmaScroll: {
    flex: 1,
  },
  tmaScrollContent: {
    paddingBottom: spacing.xl,
  },
  tmaBottomBar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tmaBarButton: {
    flex: 1,
  },
});
