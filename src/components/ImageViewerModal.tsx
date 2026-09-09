import { useState } from 'react';
import {
  FlatList,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ProductImage } from './ProductImage';
import { Product } from '../types';
import { spacing, fontSizes } from '../constants/theme';

interface ImageViewerModalProps {
  visible: boolean;
  images: (string | null)[];
  initialIndex: number;
  product: Product;
  onClose: () => void;
}

/**
 * Fullscreen swipeable image viewer: black background, back arrow top-left,
 * "n / m" counter top-right. Opens when the shopper taps a product image on
 * the detail page; swipes sideways (or taps the image) move between images.
 */
export function ImageViewerModal({
  visible,
  images,
  initialIndex,
  product,
  onClose,
}: ImageViewerModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Remount on every open so the pager starts on the tapped image. */}
      {visible ? (
        <ViewerContent
          images={images}
          initialIndex={initialIndex}
          product={product}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function ViewerContent({
  images,
  initialIndex,
  product,
  onClose,
}: Omit<ImageViewerModalProps, 'visible'>) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const index = Math.round(event.nativeEvent.contentOffset.x / windowWidth);
    const clamped = Math.min(Math.max(index, 0), images.length - 1);
    // onScroll fires continuously during a swipe; only update when the
    // active page actually changes (momentum events are unreliable in
    // react-native-web inside the Telegram WebView).
    setActiveIndex((prev) => (prev === clamped ? prev : clamped));
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={images}
        horizontal
        pagingEnabled
        initialScrollIndex={initialIndex}
        getItemLayout={(_, index) => ({
          length: windowWidth,
          offset: windowWidth * index,
          index,
        })}
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, index) => `viewer-${index}`}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        onMomentumScrollEnd={handleScroll}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.slide, { width: windowWidth, height: windowHeight }]}
            activeOpacity={1}
            onPress={onClose}
          >
            <ProductImage
              uri={item}
              category={product.category}
              name={product.name}
              contentFit="contain"
              style={styles.image}
            />
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity
        style={styles.closeButton}
        onPress={onClose}
        activeOpacity={0.7}
      >
        <Ionicons name="chevron-back" size={28} color="#ffffff" />
      </TouchableOpacity>
      {images.length > 1 && (
        // NOTE: an absolutely-positioned bare <Text> does not rasterize
        // inside a react-native-web Modal in the Telegram WebView — wrap it
        // in a positioned View (same shape as the close button above).
        <View style={styles.counterWrap}>
          <Text style={styles.counter}>
            {activeIndex + 1} / {images.length}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  slide: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  // Absolute-positioned chrome (same pattern as ProductViewerModal's close
  // button): a space-between header row does not paint reliably inside a
  // react-native-web Modal in the Telegram WebView.
  closeButton: {
    position: 'absolute',
    top: spacing.xl,
    left: spacing.md,
    padding: spacing.xs,
    zIndex: 1,
  },
  counterWrap: {
    position: 'absolute',
    top: spacing.xl,
    right: spacing.lg,
    padding: spacing.xs,
    zIndex: 1,
  },
  counter: {
    color: '#ffffff',
    fontSize: fontSizes.md,
    fontWeight: '600',
  },
});
