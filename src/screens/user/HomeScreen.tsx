import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen } from '../../components/Screen';
import { SearchBar } from '../../components/SearchBar';
import { CategoryFilter } from '../../components/CategoryFilter';
import { ProductCard } from '../../components/ProductCard';
import { ProductViewerModal } from '../../components/ProductViewerModal';
import { EmptyState } from '../../components/EmptyState';
import { WebHeader } from '../../components/WebHeader';
import { ThemeToggle } from '../../components/ThemeToggle';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { Category, Product } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { ADMIN_KEYWORD } from '../../constants/admin';
import { useThemeColors, spacing, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_CONTENT_WIDTH = 1200;

type Navigation = NativeStackNavigationProp<RootStackParamList>;

type ListItem = Product | { id: string; filler: true };

export function HomeScreen() {
  const navigation = useNavigation<Navigation>();
  const { products, addToCart } = useApp();
  const { breakpoint, isDesktop } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [viewerProductId, setViewerProductId] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === ADMIN_KEYWORD.toLowerCase()) {
      setQuery('');
      navigation.navigate('AdminLogin');
    }
  }, [query, navigation]);

  const filtered = useMemo(() => {
    return products.filter((product) => {
      const matchesCategory = selectedCategory
        ? product.category === selectedCategory
        : true;
      const matchesSearch =
        query.trim() === '' ||
        product.name.toLowerCase().includes(query.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [products, selectedCategory, query]);

  const numColumns = breakpoint === 'lg' ? 4 : breakpoint === 'md' ? 3 : 2;

  const listData = useMemo<ListItem[]>(() => {
    const remainder = filtered.length % numColumns;
    if (remainder === 0) return filtered;
    const fillers: ListItem[] = Array.from({ length: numColumns - remainder }, (_, i) => ({
      id: `filler-${i}`,
      filler: true as const,
    }));
    return [...filtered, ...fillers];
  }, [filtered, numColumns]);

  const isWeb = Platform.OS === 'web';
  const showInlineSearch = !isWeb || !isDesktop;

  return (
    <>
      {isWeb && <WebHeader searchValue={query} onSearchChange={setQuery} />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.content}>
          <View style={styles.filterSection}>
            <CategoryFilter
              selected={selectedCategory}
              onSelect={setSelectedCategory}
            />

            {showInlineSearch && (
              <View style={styles.searchContainer}>
                <View style={styles.searchBar}>
                  <SearchBar value={query} onChangeText={setQuery} />
                </View>
                <ThemeToggle />
              </View>
            )}
          </View>

          <FlatList
            key={numColumns}
            data={listData}
            keyExtractor={(item) => item.id}
            numColumns={numColumns}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <EmptyState message="No items found. Try a different search or category." />
            }
            renderItem={({ item }) => {
              if ('filler' in item) {
                return <View style={styles.filler} />;
              }
              return (
                <ProductCard
                  product={item}
                  onPress={() => setViewerProductId(item.id)}
                />
              );
            }}
          />
        </View>

        <ProductViewerModal
          visible={viewerProductId !== null}
          product={products.find((p) => p.id === viewerProductId) ?? null}
          onClose={() => setViewerProductId(null)}
          onAddToCart={(selectedImageIndex) => {
            const product = products.find((p) => p.id === viewerProductId);
            if (product) addToCart(product, selectedImageIndex);
          }}
        />
      </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    content: {
      flex: 1,
      maxWidth: MAX_CONTENT_WIDTH,
      width: '100%',
      alignSelf: 'center',
    },
    filterSection: {
      paddingHorizontal: spacing.lg,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    searchBar: {
      flex: 1,
    },
    list: {
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.xl,
      flexGrow: 1,
    },
    filler: {
      flex: 1,
      margin: spacing.xs,
      backgroundColor: 'transparent',
    },
  });
