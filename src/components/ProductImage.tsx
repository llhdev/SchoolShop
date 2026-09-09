import { useEffect, useState } from 'react';
import { Image } from 'expo-image';
import { ImageStyle, StyleProp, StyleSheet, Text, View } from 'react-native';
import { Category } from '../types';
import { getCategoryColor } from '../constants/categories';
import { getThumbnailUrl } from '../utils/images';

interface ProductImageProps {
  /** Remote URL, local/data URI, or null (renders a local placeholder). */
  uri: string | null;
  category?: Category;
  name?: string;
  /** When true, requests the `-thumb.jpg` variant and falls back to the full URL on error. */
  thumbnail?: boolean;
  style?: StyleProp<ImageStyle>;
  contentFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
}

/**
 * Cached product image (expo-image: memory + disk cache). Replaces RN core
 * Image on all product surfaces. When no image exists it renders a local
 * category-colored placeholder with the product initial — no network needed.
 */
export function ProductImage({
  uri,
  category,
  name,
  thumbnail = false,
  style,
  contentFit = 'contain',
}: ProductImageProps) {
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    setThumbFailed(false);
  }, [uri]);

  const isRemote = !!uri && (uri.startsWith('http://') || uri.startsWith('https://'));
  const tryThumb = thumbnail && isRemote && !thumbFailed;
  const sourceUri = uri ? (tryThumb ? getThumbnailUrl(uri) : uri) : null;

  if (!sourceUri) {
    const backgroundColor = getCategoryColor(category ?? '');
    const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
    return (
      <View style={[styles.placeholder, { backgroundColor }, style]}>
        <Text style={styles.initial}>{initial}</Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri: sourceUri }}
      style={style}
      contentFit={contentFit}
      transition={150}
      onError={tryThumb ? () => setThumbFailed(true) : undefined}
    />
  );
}

const styles = StyleSheet.create({
  placeholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  initial: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
});
