import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Dimensions,
  FlatList,
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ProductImage } from '../../components/ProductImage';
import { ImageViewerModal } from '../../components/ImageViewerModal';
import { TelegramChatButton } from '../../components/TelegramChatButton';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { getProductGalleryImages } from '../../utils/images';
import { hasUnselectedGroups, resolveVariantPrice } from '../../utils/variants';
import { CartItem, ProductFile, VariantGroup, VariantOption } from '../../types';
import { isTelegramMiniApp, openTelegramChat } from '../../lib/telegram';
import { fetchProductFiles } from '../../services/productFiles';
import { formatFileSize, formatPrice, getDiscountPercent } from '../../utils/format';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const PHONE_IMAGE_HEIGHT_RATIO = 0.65;
const MAX_WIDTH = 1200;
const MAX_QUANTITY = 99;

/** Quantity picker next to the Buy button (no cart — the quantity goes
 *  straight to checkout with the single line item). Button styling mirrors
 *  the old ProductCard quick-add circles. */
function QuantityStepper({
  quantity,
  onChange,
}: {
  quantity: number;
  onChange: (next: number) => void;
}) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  return (
    <View style={styles.stepper}>
      <TouchableOpacity
        style={[styles.stepperButton, quantity <= 1 && styles.stepperButtonDisabled]}
        onPress={() => onChange(Math.max(1, quantity - 1))}
        disabled={quantity <= 1}
        activeOpacity={0.8}
      >
        <Ionicons name="remove" size={16} color={colors.primary} />
      </TouchableOpacity>
      <Text style={styles.stepperValue}>{quantity}</Text>
      <TouchableOpacity
        style={[styles.stepperButton, quantity >= MAX_QUANTITY && styles.stepperButtonDisabled]}
        onPress={() => onChange(Math.min(MAX_QUANTITY, quantity + 1))}
        disabled={quantity >= MAX_QUANTITY}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={18} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

/** One detail image sized to its natural aspect ratio (fully visible, never
 *  cropped). Before the dimensions are known a 3:4 placeholder box is shown;
 *  it snaps to the real ratio once expo-image reports the source size. No
 *  height cap: the width always fills the display area and tall images just
 *  extend the scroll. */
function DetailImageItem({
  uri,
  category,
  name,
}: {
  uri: string;
  category: string;
  name: string;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const boxWidth = Math.min(windowWidth, MAX_WIDTH) - spacing.lg * 2;
  const height = natural ? (natural.h / natural.w) * boxWidth : boxWidth * 0.75;

  return (
    <View style={[styles.detailImageContainer, { height }]}>
      <ProductImage
        uri={uri}
        category={category}
        name={name}
        style={styles.detailImage}
        contentFit="contain"
        onLoad={(event) => {
          const source = event.source;
          if (source.width && source.height) {
            setNatural({ w: source.width, h: source.height });
          }
        }}
      />
    </View>
  );
}

export function ProductDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { productId } = route.params as { productId: string };
  const { products, role } = useApp();
  const { isDesktop } = useResponsive();
  const { width: windowWidth } = useWindowDimensions();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [activeIndex, setActiveIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  /** Chosen variant options: group name → option name. */
  const [selected, setSelected] = useState<Record<string, string>>({});
  /** Set when the shopper tries to buy without picking every group. */
  const [variantError, setVariantError] = useState(false);
  /** Free downloadable PDFs attached to a price-0 post (migration 044). */
  const [freeFiles, setFreeFiles] = useState<ProductFile[]>([]);
  const galleryRef = useRef<FlatList>(null);
  const isTMA = isTelegramMiniApp();

  const product = products.find((p) => p.id === productId);
  const isFreeDownload = !!product && !product.priceHidden && product.price === 0;
  // Buy UI is shopper-only: admins share this screen but Checkout is not
  // registered in the admin stack. Free downloads and price-on-request posts
  // have no buy UI either.
  const canBuy = role === 'user' && !!product && !product.priceHidden && !isFreeDownload;

  useEffect(() => {
    if (!isFreeDownload || !product) return;
    fetchProductFiles(product.id)
      .then(setFreeFiles)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, isFreeDownload]);

  if (!product) {
    return (
      <Screen>
        <EmptyState message="Product not found." icon="alert-circle-outline" />
      </Screen>
    );
  }

  const galleryImages = useMemo(() => getProductGalleryImages(product), [product]);
  const variantGroups = product.variantGroups ?? [];
  const priceGroup = variantGroups.find((g) => g.affectsPrice);
  /** Set once the shopper has picked an option in the price group. */
  const variantPriceChosen = !!priceGroup && !!selected[priceGroup.name];
  const displayPrice = variantPriceChosen
    ? resolveVariantPrice(product, selected)
    : product.price;
  // Discount badges compare against the product's base price — hide them once
  // a variant price takes over.
  const discount = variantPriceChosen
    ? null
    : getDiscountPercent(product.price, product.compareAtPrice);
  const isWebDesktop = Platform.OS === 'web' && isDesktop;

  /** Record a picked option; jump the gallery to its photo when it has one. */
  const pickOption = (group: VariantGroup, option: VariantOption) => {
    const next = { ...selected, [group.name]: option.name };
    setSelected(next);
    if (variantError && !hasUnselectedGroups(product, next)) setVariantError(false);
    if (
      option.imageIndex !== undefined &&
      option.imageIndex >= 0 &&
      option.imageIndex < galleryImages.length
    ) {
      setActiveIndex(option.imageIndex);
      galleryRef.current?.scrollToOffset({
        offset: option.imageIndex * windowWidth,
        animated: true,
      });
    }
  };

  /** Build the checkout line's variant payload, or null when a group is
   *  still unpicked. */
  const buildSelection = ():
    | { selectedOptions: { group: string; option: string }[]; unitPrice: number }
    | null => {
    if (variantGroups.length === 0) return null;
    if (hasUnselectedGroups(product, selected)) {
      setVariantError(true);
      return null;
    }
    return {
      selectedOptions: variantGroups.map((g) => ({ group: g.name, option: selected[g.name] })),
      unitPrice: resolveVariantPrice(product, selected),
    };
  };

  // No cart: Buy goes straight to Checkout with the single line item.
  function handleBuy() {
    if (!product) return;
    const selection = buildSelection();
    if (variantGroups.length > 0 && !selection) return;
    const item: CartItem = {
      product,
      quantity,
      selectedImageIndex: activeIndex,
      selectedOptions: selection?.selectedOptions,
      unitPrice: selection?.unitPrice,
    };
    navigation.navigate('Checkout', { items: [item] });
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

  const infoSection = (    <View style={styles.info}>
      {isTMA ? (
        // Mini App: clean stacked layout — smaller, lighter product name on
        // its own line, then a single price row.
        <>
          <Text style={styles.tmaName} numberOfLines={2}>
            {product.name}
          </Text>
          <View style={styles.tmaPriceRow}>
            {product.priceHidden ? (
              <Text style={styles.priceOnRequest}>Price on request</Text>
            ) : isFreeDownload ? (
              <Text style={styles.tmaPrice}>Free</Text>
            ) : (
              <>
                <Text style={styles.tmaPrice}>{formatPrice(displayPrice)}</Text>
                {discount !== null && product.compareAtPrice && (
                  <Text style={styles.compareAt}>{formatPrice(product.compareAtPrice)}</Text>
                )}
                {discount !== null && (
                  <Text style={styles.discountTag}>Save {discount}%</Text>
                )}
              </>
            )}
          </View>
        </>
      ) : (
        <View style={styles.headerRow}>
          <Text style={styles.name} numberOfLines={2}>
            {product.name}
          </Text>
          <View style={styles.priceBlock}>
            {product.priceHidden ? (
              <Text style={styles.priceOnRequest}>Price on request</Text>
            ) : isFreeDownload ? (
              <Text style={styles.price}>Free</Text>
            ) : (
              <>
                {discount !== null && product.compareAtPrice && (
                  <Text style={styles.compareAt}>{formatPrice(product.compareAtPrice)}</Text>
                )}
                <Text style={styles.price}>{formatPrice(displayPrice)}</Text>
                {discount !== null && (
                  <Text style={styles.discountTag}>Save {discount}%</Text>
                )}
              </>
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

      {!product.priceHidden &&
        variantGroups.map((group) => {
          const missing = variantError && !selected[group.name];
          return (
            <View key={group.name} style={styles.variantGroup}>
              <Text style={[styles.variantGroupTitle, missing && styles.variantGroupTitleError]}>
                {group.name}
              </Text>
              {group.affectsPrice ? (
                // Price group: one row per option, optional photo + its price.
                group.options.map((option) => {
                  const isSelected = selected[group.name] === option.name;
                  const thumbUri =
                    option.imageIndex !== undefined
                      ? galleryImages[option.imageIndex] ?? null
                      : null;
                  return (
                    <TouchableOpacity
                      key={option.name}
                      style={[styles.variantRow, isSelected && styles.variantRowSelected]}
                      onPress={() => pickOption(group, option)}
                    >
                      {thumbUri ? (
                        <ProductImage
                          uri={thumbUri}
                          category={product.category}
                          name={product.name}
                          style={styles.variantThumb}
                          contentFit="cover"
                        />
                      ) : null}
                      <Text
                        style={[styles.variantOptionName, isSelected && styles.variantTextSelected]}
                        numberOfLines={2}
                      >
                        {option.name}
                      </Text>
                      <Text style={[styles.variantOptionPrice, isSelected && styles.variantTextSelected]}>
                        {formatPrice(option.price ?? product.price)}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              ) : (
                // Non-price group: simple chips.
                <View style={styles.variantChips}>
                  {group.options.map((option) => {
                    const isSelected = selected[group.name] === option.name;
                    return (
                      <TouchableOpacity
                        key={option.name}
                        style={[styles.variantChip, isSelected && styles.variantChipSelected]}
                        onPress={() => pickOption(group, option)}
                      >
                        <Text style={[styles.variantChipText, isSelected && styles.variantTextSelected]}>
                          {option.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
              {missing && (
                <Text style={styles.variantErrorText}>
                  Please choose a {group.name.toLowerCase()}
                </Text>
              )}
            </View>
          );
        })}

      {!isTMA && (
        <View style={styles.actions}>
          <TelegramChatButton
            username={product.ownerTelegramUsername}
            style={styles.chatIconButton}
          />
          {canBuy && (
            <>
              <QuantityStepper quantity={quantity} onChange={setQuantity} />
              <Button
                title="Buy Now"
                onPress={handleBuy}
                style={styles.actionButton}
              />
            </>
          )}
        </View>
      )}

      {product.description.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Description</Text>
          <Text style={styles.description}>{product.description}</Text>
        </>
      )}
    </View>
  );

  // Extra tenant-uploaded photos (size charts, close-ups), listed under the
  // description; the shopper reaches them by scrolling. Not part of the
  // swipeable main gallery.
  const detailImagesSection =
    product.detailImages && product.detailImages.length > 0 ? (
      <View style={[styles.detailSection, isWebDesktop && styles.detailSectionDesktop]}>
        <Text style={styles.sectionTitle}>Details</Text>
        {product.detailImages.map((uri, index) => (
          <DetailImageItem
            key={`detail-${index}`}
            uri={uri}
            category={product.category}
            name={product.name}
          />
        ))}
      </View>
    ) : null;

  // Free download posts (price 0, migration 044): the attached PDFs, one row
  // each, opened in the browser/viewer via the public R2 URL.
  const downloadsSection =
    isFreeDownload && freeFiles.length > 0 ? (
      <View style={[styles.detailSection, isWebDesktop && styles.detailSectionDesktop]}>
        <Text style={styles.sectionTitle}>Downloads</Text>
        {freeFiles.map((file) => (
          <TouchableOpacity
            key={file.id}
            style={styles.downloadRow}
            onPress={() => Linking.openURL(file.url)}
            activeOpacity={0.7}
          >
            <Ionicons name="document-text-outline" size={20} color={colors.primary} />
            <Text style={styles.downloadName} numberOfLines={1}>
              {file.name}
            </Text>
            <Text style={styles.downloadSize}>{formatFileSize(file.sizeBytes)}</Text>
            <Ionicons name="download-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
        ))}
      </View>
    ) : null;

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
          {downloadsSection}
          {detailImagesSection}
        </ScrollView>
      </Screen>
    );
  }

  const gallerySection = (
    <View style={[styles.galleryContainer, { height: phoneImageHeight }]}>
      <FlatList
        ref={galleryRef}
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
        renderItem={({ item, index }) => (
          <TouchableOpacity
            style={[styles.imageSlide, { width: windowWidth, height: phoneImageHeight }]}
            activeOpacity={0.9}
            onPress={() => {
              setViewerIndex(index);
              setViewerVisible(true);
            }}
          >
            <ProductImage
              uri={item}
              category={product.category}
              name={product.name}
              style={styles.image}
            />
          </TouchableOpacity>
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
      <ImageViewerModal
        visible={viewerVisible}
        images={galleryImages}
        initialIndex={viewerIndex}
        product={product}
        onClose={() => setViewerVisible(false)}
      />
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
            {downloadsSection}
            {detailImagesSection}
          </ScrollView>
          <View style={styles.tmaBottomBar}>
            {product.priceHidden ? (
              product.ownerTelegramUsername?.trim() ? (
                <Button
                  title="Chat to Order"
                  onPress={() => openTelegramChat(product.ownerTelegramUsername!.trim())}
                  style={styles.tmaBarButton}
                />
              ) : (
                <Text style={styles.priceOnRequest}>Chat with the shop to order</Text>
              )
            ) : isFreeDownload ? (
              <>
                <TelegramChatButton
                  username={product.ownerTelegramUsername}
                  size={24}
                  style={styles.tmaChatButton}
                />
                <Text style={styles.tmaFreeNote}>Free — download above</Text>
              </>
            ) : (
              <>
                <TelegramChatButton
                  username={product.ownerTelegramUsername}
                  size={24}
                  style={styles.tmaChatButton}
                />
                {canBuy && (
                  <>
                    <QuantityStepper quantity={quantity} onChange={setQuantity} />
                    <Button title="Buy" onPress={handleBuy} style={styles.tmaBarButton} />
                  </>
                )}
              </>
            )}
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll noPadding edges={['top', 'left', 'right']}>
      {gallerySection}
      {infoSection}
      {downloadsSection}
      {detailImagesSection}
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
  detailSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  detailSectionDesktop: {
    maxWidth: MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
  },
  downloadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
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
  tmaFreeNote: {
    flex: 1,
    textAlign: 'center',
    alignSelf: 'center',
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  detailImageContainer: {
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },
  detailImage: {
    width: '100%',
    height: '100%',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'center',
  },
  stepperButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepperButtonDisabled: {
    borderColor: colors.border,
    opacity: 0.5,
  },
  stepperValue: {
    minWidth: 24,
    textAlign: 'center',
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
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
  priceOnRequest: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.textSecondary,
    alignSelf: 'center',
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
  // Bordered circle at the left of the Mini App bottom bar; matches the
  // height of the neighbouring buttons so the bar stays even.
  tmaChatButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  chatIconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  variantGroup: {
    marginBottom: spacing.md,
  },
  variantGroupTitle: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  variantGroupTitleError: {
    color: colors.danger,
  },
  variantChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  variantChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background,
  },
  variantChipSelected: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  variantChipText: {
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  variantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  variantRowSelected: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  variantThumb: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.surface,
  },
  variantOptionName: {
    flex: 1,
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  variantOptionPrice: {
    fontSize: fontSizes.sm,
    fontWeight: '700',
    color: colors.price,
  },
  variantTextSelected: {
    color: colors.primary,
  },
  variantErrorText: {
    fontSize: fontSizes.sm,
    color: colors.danger,
    marginTop: spacing.xs,
  },
});
