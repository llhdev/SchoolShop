import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './Button';
import { Product } from '../types';
import { getProductGalleryImages } from '../utils/images';
import { formatPrice } from '../utils/format';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

interface ProductViewerModalProps {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  onAddToCart?: (selectedImageIndex: number) => void;
}

export function ProductViewerModal({
  visible,
  product,
  onClose,
  onAddToCart,
}: ProductViewerModalProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const flatListRef = useRef<FlatList<string>>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const galleryImages = useMemo(
    () => (product ? getProductGalleryImages(product) : []),
    [product]
  );

  useEffect(() => {
    if (visible) {
      setActiveIndex(0);
      const timeout = setTimeout(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
      }, 50);
      return () => clearTimeout(timeout);
    }
  }, [visible, product?.id]);

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const index = Math.round(event.nativeEvent.contentOffset.x / windowWidth);
    setActiveIndex(Math.min(Math.max(index, 0), galleryImages.length - 1));
  }

  function scrollToIndex(index: number) {
    if (index < 0 || index >= galleryImages.length) return;
    setActiveIndex(index);
    flatListRef.current?.scrollToOffset({
      offset: windowWidth * index,
      animated: true,
    });
  }

  const imageHeight = Math.min(windowWidth, windowHeight * 0.55);
  const isWeb = Platform.OS === 'web';

  if (!product) {
    return null;
  }

  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>

        <TouchableWithoutFeedback onPress={() => {}}>
          <View style={styles.page}>
            <View style={[styles.galleryContainer, { height: imageHeight }]}>
              <FlatList
                ref={flatListRef}
                data={galleryImages}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                bounces={galleryImages.length > 1}
                scrollEnabled={galleryImages.length > 1}
                keyExtractor={(_, index) => `gallery-${index}`}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onMomentumScrollEnd={handleScroll}
                renderItem={({ item }) => (
                  <View
                    style={[
                      styles.imageSlide,
                      { width: windowWidth, height: imageHeight },
                    ]}
                  >
                    <Image
                      source={{ uri: item }}
                      style={styles.image}
                      resizeMode="contain"
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
                    <TouchableOpacity
                      key={index}
                      activeOpacity={0.7}
                      onPress={() => scrollToIndex(index)}
                      disabled={!isWeb}
                      style={[
                        styles.dot,
                        index === activeIndex && styles.activeDot,
                        isWeb && styles.dotClickable,
                      ]}
                    />
                  ))}
                </View>
              )}
            </View>

            {isWeb && galleryImages.length > 1 && (
              <View style={styles.thumbnailRow}>
                {galleryImages.map((uri, index) => (
                  <TouchableOpacity
                    key={index}
                    activeOpacity={0.8}
                    onPress={() => scrollToIndex(index)}
                    style={[
                      styles.thumbnailButton,
                      index === activeIndex && styles.thumbnailButtonActive,
                    ]}
                  >
                    <Image
                      source={{ uri }}
                      style={styles.thumbnailImage}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={styles.info}>
              <View style={styles.headerRow}>
                <Text style={styles.name} numberOfLines={2}>
                  {product.name}
                </Text>
                <Text style={styles.price}>{formatPrice(product.price)}</Text>
              </View>

              <View style={styles.metaRow}>
                <Text style={styles.category}>{product.category}</Text>
                {galleryImages.length > 1 && (
                  <Text style={styles.counter}>
                    {activeIndex + 1} / {galleryImages.length}
                  </Text>
                )}
              </View>

              {onAddToCart && (
                <Button
                  title="Add to Cart"
                  onPress={() => {
                    onAddToCart(activeIndex);
                    onClose();
                  }}
                  style={styles.addToCartButton}
                />
              )}
            </View>
          </View>
        </TouchableWithoutFeedback>

        <TouchableOpacity
          style={styles.closeButton}
          onPress={onClose}
          activeOpacity={0.7}
        >
          <Ionicons name="close" size={24} color={colors.surface} />
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
  },
  closeButton: {
    position: 'absolute',
    top: spacing.xl + 8,
    right: spacing.lg,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  page: {
    justifyContent: 'center',
  },
  galleryContainer: {
    width: '100%',
    backgroundColor: colors.surface,
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
  dotClickable: {
    ...(Platform.OS === 'web'
      ? ({
          cursor: 'pointer',
        } as any)
      : {}),
  },
  activeDot: {
    backgroundColor: colors.primary,
    width: 18,
    height: 8,
    borderRadius: 4,
  },
  thumbnailRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  thumbnailButton: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.background,
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
  info: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    marginTop: -spacing.md,
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
    fontSize: fontSizes.xl,
    fontWeight: '700',
    color: colors.text,
  },
  price: {
    fontSize: fontSizes.xl,
    fontWeight: '800',
    color: colors.price,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  category: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
  },
  counter: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  description: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    lineHeight: 22,
  },
  addToCartButton: {
    marginTop: spacing.md,
  },
});
