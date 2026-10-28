import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen } from '../../components/Screen';
import { SearchBar } from '../../components/SearchBar';
import { CategoryFilter, SortOption } from '../../components/CategoryFilter';
import { StoreList, StoreSummary } from '../../components/StoreList';
import { ProductCard } from '../../components/ProductCard';
import { ProductViewerModal } from '../../components/ProductViewerModal';
import { EmptyState } from '../../components/EmptyState';
import { WebHeader } from '../../components/WebHeader';
import { ThemeToggle } from '../../components/ThemeToggle';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { Category, Product } from '../../types';
import { RootStackParamList } from '../../types/navigation';
import { supabase } from '../../lib/supabase';
import { isTelegramMiniApp } from '../../lib/telegram';
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
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const [storePanelOpen, setStorePanelOpen] = useState(false);
  const [viewerProductId, setViewerProductId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('featured');

  // "Featured" order: a random scramble built once per app session and kept
  // stable afterwards, so realtime updates don't make the grid jump around.
  // Products added later get no rank and append at the end.
  const featuredRankRef = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return;

    let cancelled = false;

    async function checkAdminUsername() {
      const { data, error } = await supabase.rpc('get_admin_by_username', {
        username: trimmed,
      });

      if (cancelled || error || !data || data.length === 0) return;

      const admin = data[0] as { email: string; role: string };
      if (admin.email && admin.role) {
        setQuery('');
        navigation.navigate('AdminLogin', {
          username: trimmed,
          email: admin.email,
        });
      }
    }

    const timeout = setTimeout(checkAdminUsername, 400);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query, navigation]);

  // One store entry per tenant owner, derived from the (cached, realtime)
  // product catalog — a tenant only appears here once they have products.
  const stores = useMemo<StoreSummary[]>(() => {
    const map = new Map<string, StoreSummary>();
    for (const product of products) {
      if (!product.ownerId || !product.shopName) continue;
      const existing = map.get(product.ownerId);
      if (!existing) {
        map.set(product.ownerId, {
          ownerId: product.ownerId,
          shopName: product.shopName,
          logoUrl: product.ownerShopLogoUrl,
          description: product.ownerShopDescription,
        });
      } else {
        if (!existing.logoUrl && product.ownerShopLogoUrl) {
          existing.logoUrl = product.ownerShopLogoUrl;
        }
        if (!existing.description && product.ownerShopDescription) {
          existing.description = product.ownerShopDescription;
        }
      }
    }
    return [...map.values()].sort((a, b) => a.shopName.localeCompare(b.shopName));
  }, [products]);

  // If the selected store disappears from the catalog (tenant/products
  // removed), drop the filter instead of showing an empty grid.
  const activeOwnerId =
    selectedOwnerId && stores.some((s) => s.ownerId === selectedOwnerId)
      ? selectedOwnerId
      : null;
  const activeStore = stores.find((s) => s.ownerId === activeOwnerId) ?? null;

  const filtered = useMemo(() => {
    return products.filter((product) => {
      const matchesCategory = selectedCategory
        ? product.category === selectedCategory
        : true;
      const matchesStore = activeOwnerId
        ? product.ownerId === activeOwnerId
        : true;
      const matchesSearch =
        query.trim() === '' ||
        product.name.toLowerCase().includes(query.toLowerCase());
      return matchesCategory && matchesStore && matchesSearch;
    });
  }, [products, selectedCategory, activeOwnerId, query]);

  const sorted = useMemo(() => {
    if (sortBy === 'featured') {
      if (!featuredRankRef.current) {
        const ids = filtered.map((p) => p.id);
        // Fisher–Yates shuffle.
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        featuredRankRef.current = new Map(ids.map((id, index) => [id, index]));
      }
      const rank = featuredRankRef.current;
      return [...filtered].sort(
        (a, b) =>
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      );
    }

    const list = [...filtered];
    switch (sortBy) {
      case 'latest':
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        break;
      case 'popular':
        list.sort((a, b) => (b.orderCount ?? 0) - (a.orderCount ?? 0));
        break;
      case 'price_asc':
      case 'price_desc': {
        // Price-on-request products (priceHidden) always sort last in both
        // directions; they have no meaningful price.
        const direction = sortBy === 'price_asc' ? 1 : -1;
        list.sort(
          (a, b) =>
            (a.priceHidden ? 1 : 0) - (b.priceHidden ? 1 : 0) ||
            (a.price - b.price) * direction
        );
        break;
      }
    }
    return list;
  }, [filtered, sortBy]);

  const numColumns = breakpoint === 'lg' ? 4 : breakpoint === 'md' ? 3 : 2;

  const listData = useMemo<ListItem[]>(() => {
    const remainder = sorted.length % numColumns;
    if (remainder === 0) return sorted;
    const fillers: ListItem[] = Array.from({ length: numColumns - remainder }, (_, i) => ({
      id: `filler-${i}`,
      filler: true as const,
    }));
    return [...sorted, ...fillers];
  }, [sorted, numColumns]);

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
              onSelect={(category) => {
                setSelectedCategory(category);
                setStorePanelOpen(false);
              }}
              storeLabel={activeStore?.shopName ?? 'Store'}
              storeActive={activeOwnerId !== null}
              storePanelOpen={storePanelOpen}
              onStorePress={
                stores.length > 0
                  ? () => setStorePanelOpen((open) => !open)
                  : undefined
              }
              sort={sortBy}
              onSortChange={setSortBy}
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

          {storePanelOpen && stores.length > 0 ? (
            <StoreList
              stores={stores}
              selectedOwnerId={activeOwnerId}
              onSelect={(ownerId) => {
                setSelectedOwnerId(ownerId);
                setStorePanelOpen(false);
              }}
            />
          ) : (
          <FlatList
            key={numColumns}
            data={listData}
            keyExtractor={(item) => item.id}
            numColumns={numColumns}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <EmptyState message="No items found. Try a different search, category, or store." />
            }
            renderItem={({ item }) => {
              if ('filler' in item) {
                return <View style={styles.filler} />;
              }
              return (
                <ProductCard
                  product={item}
                  onPress={() => {
                    // Mini App + web: full-screen product page. Native: quick-view modal.
                    if (isTelegramMiniApp() || Platform.OS === 'web') {
                      navigation.navigate('ProductDetail', { productId: item.id });
                    } else {
                      setViewerProductId(item.id);
                    }
                  }}
                />
              );
            }}
          />
          )}
        </View>

        <ProductViewerModal
          visible={viewerProductId !== null}
          product={products.find((p) => p.id === viewerProductId) ?? null}
          onClose={() => setViewerProductId(null)}
          onAddToCart={(selectedImageIndex) => {
            const product = products.find((p) => p.id === viewerProductId);
            // Free download posts (price 0) are never added to the cart.
            if (product && product.price > 0) addToCart(product, selectedImageIndex);
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
