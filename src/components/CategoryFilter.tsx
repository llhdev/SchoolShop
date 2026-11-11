import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  LayoutChangeEvent,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Chip } from './Chip';
import { useApp } from '../context/AppContext';
import { Category } from '../types';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

interface CategoryFilterProps {
  selected: Category | null;
  onSelect: (category: Category | null) => void;
  /** Optional "Store" chip rendered right after "All" (tenant shop filter). */
  storeLabel?: string;
  storeActive?: boolean;
  storePanelOpen?: boolean;
  onStorePress?: () => void;
  /** Active sort for the second (sort) chip row. */
  sort: SortOption;
  onSortChange: (sort: SortOption) => void;
}

/** Product listing sorts. `featured` is the session-stable random scramble. */
export type SortOption = 'featured' | 'latest' | 'popular' | 'price_asc' | 'price_desc';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const SORT_OPTIONS: { value: SortOption; label: string; icon?: IconName }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'latest', label: 'Latest' },
  { value: 'popular', label: 'Popular' },
  { value: 'price_asc', label: 'Price', icon: 'arrow-up' },
  { value: 'price_desc', label: 'Price', icon: 'arrow-down' },
];

/** Shop names can be long; the store chip truncates so the row stays one line. */
const STORE_LABEL_MAX = 18;

interface MeasuredWidths {
  all: number;
  store?: number;
  more: number;
  categories: Record<string, number>;
}

export function CategoryFilter({
  selected,
  onSelect,
  storeLabel,
  storeActive = false,
  onStorePress,
  sort,
  onSortChange,
}: CategoryFilterProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { categories } = useApp();
  const hasStore = Boolean(onStorePress);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const [moreLayout, setMoreLayout] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measured, setMeasured] = useState<MeasuredWidths | null>(null);
  const pendingRef = useRef<{ all?: number; store?: number; more?: number; categories: Record<string, number> }>({
    categories: {},
  });
  const moreButtonRef = useRef<View>(null);

  // Matches the rendered row gap — the fit math must use the same value or
  // the last visible chip overflows on narrow screens.
  const gap = spacing.sm;
  const categoriesKey = categories.join('\n');

  const displayStoreLabel =
    storeLabel && storeLabel.length > STORE_LABEL_MAX
      ? `${storeLabel.slice(0, STORE_LABEL_MAX - 1)}…`
      : (storeLabel ?? 'Store');

  // Categories (and the store chip label) can change at runtime; re-measure
  // when the inputs change.
  useEffect(() => {
    setMeasured(null);
    pendingRef.current = { categories: {} };
  }, [categoriesKey, hasStore, storeLabel]);

  const visibleCount = useMemo(() => {
    if (!measured || containerWidth <= 0) return categories.length;

    const fitCount = (reserveMore: boolean): number => {
      const moreReserve = reserveMore ? gap + measured.more : 0;
      let used = measured.all + (hasStore ? gap + (measured.store ?? 0) : 0);
      let count = 0;
      for (const category of categories) {
        const width = measured.categories[category] ?? 0;
        const candidate = used + gap + width;
        if (candidate + moreReserve > containerWidth) break;
        used = candidate;
        count += 1;
      }
      return count;
    };

    if (fitCount(false) >= categories.length) return categories.length;
    return fitCount(true);
  }, [measured, containerWidth, categories, gap, hasStore]);

  const visibleCategories = categories.slice(0, visibleCount);
  const hiddenCategories = categories.slice(visibleCount);

  function handleSelect(category: Category | null) {
    onSelect(category);
    setDropdownVisible(false);
  }

  function recordMeasurement(
    key: 'all' | 'store' | 'more' | string,
    event: LayoutChangeEvent,
  ) {
    const width = event.nativeEvent.layout.width;
    const pending = pendingRef.current;
    if (key === 'all') pending.all = width;
    else if (key === 'store') pending.store = width;
    else if (key === 'more') pending.more = width;
    else pending.categories[key] = width;

    if (
      pending.all !== undefined &&
      (!hasStore || pending.store !== undefined) &&
      pending.more !== undefined &&
      categories.every((c) => pending.categories[c] !== undefined)
    ) {
      setMeasured({
        all: pending.all,
        store: pending.store,
        more: pending.more,
        categories: { ...pending.categories },
      });
    }
  }

  return (
    <View style={styles.wrapper}>
      <View
        style={styles.container}
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      >
        <Chip label="All" active={selected === null} onPress={() => onSelect(null)} />

        {hasStore && (
          <Chip label={displayStoreLabel} active={storeActive} onPress={onStorePress} />
        )}

        {visibleCategories.map((category) => (
          <Chip
            key={category}
            label={category}
            active={selected === category}
            onPress={() => onSelect(category)}
          />
        ))}

        {hiddenCategories.length > 0 && (
          <View ref={moreButtonRef} collapsable={false}>
            <Chip
              label="More"
              icon={dropdownVisible ? 'chevron-up' : 'chevron-down'}
              onPress={() => {
                moreButtonRef.current?.measure((x, y, width, height, pageX, pageY) => {
                  setMoreLayout({ x: pageX, y: pageY, width, height });
                  setDropdownVisible(true);
                });
              }}
            />
          </View>
        )}
      </View>

      {/* Second row: listing sort. */}
      <View style={[styles.container, styles.sortRow]}>
        {SORT_OPTIONS.map(({ value, label, icon }) => (
          <Chip
            key={value}
            label={label}
            icon={icon}
            active={sort === value}
            onPress={() => onSortChange(value)}
          />
        ))}
      </View>

      {/* Offscreen pass to measure chip widths before deciding the split */}
      {!measured && (
        <View style={styles.measureRow} pointerEvents="none">
          <View onLayout={(e) => recordMeasurement('all', e)}>
            <Chip label="All" />
          </View>
          {hasStore && (
            <View onLayout={(e) => recordMeasurement('store', e)}>
              <Chip label={displayStoreLabel} />
            </View>
          )}
          {categories.map((category) => (
            <View key={category} onLayout={(e) => recordMeasurement(category, e)}>
              <Chip label={category} />
            </View>
          ))}
          <View onLayout={(e) => recordMeasurement('more', e)}>
            <Chip label="More" icon="chevron-down" />
          </View>
        </View>
      )}

      <Modal
        animationType="fade"
        transparent
        visible={dropdownVisible}
        onRequestClose={() => setDropdownVisible(false)}
      >
        <TouchableWithoutFeedback onPress={() => setDropdownVisible(false)}>
          <View style={styles.dropdownOverlay}>
            <View
              style={[
                styles.dropdown,
                moreLayout && {
                  position: 'absolute',
                  top: moreLayout.y + moreLayout.height + 4,
                  right:
                    Dimensions.get('window').width -
                    (moreLayout.x + moreLayout.width),
                },
              ]}
            >
              {hiddenCategories.map((category) => (
                <TouchableOpacity
                  key={category}
                  style={styles.dropdownItem}
                  onPress={() => handleSelect(category)}
                >
                  <Text
                    style={[
                      styles.dropdownItemText,
                      selected === category && styles.dropdownItemTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {category}
                  </Text>
                  {selected === category && (
                    <Ionicons
                      name="checkmark"
                      size={16}
                      color={colors.primary}
                      style={styles.checkIcon}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  wrapper: {
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  container: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  sortRow: {
    marginTop: spacing.xs,
  },
  measureRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    flexDirection: 'row',
    opacity: 0,
  },
  dropdownOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  dropdown: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minWidth: 180,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  dropdownItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dropdownItemText: {
    fontSize: fontSizes.md,
    color: colors.text,
    flex: 1,
  },
  dropdownItemTextActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  checkIcon: {
    marginLeft: spacing.sm,
  },
});
