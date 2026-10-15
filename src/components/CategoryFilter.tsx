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
import { useApp } from '../context/AppContext';
import { useResponsive } from '../hooks/useResponsive';
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

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'latest', label: 'Latest' },
  { value: 'popular', label: 'Popular' },
  { value: 'price_asc', label: 'Price ↑' },
  { value: 'price_desc', label: 'Price ↓' },
];

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
  storePanelOpen = false,
  onStorePress,
  sort,
  onSortChange,
}: CategoryFilterProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { categories } = useApp();
  const { isPhone } = useResponsive();
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

  const gap = isPhone ? 2 : spacing.sm;
  const categoriesKey = categories.join('\n');

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

  function renderChipContent(
    label: string,
    active: boolean,
    more: boolean,
  ) {
    return (
      <Text
        style={[
          styles.text,
          isPhone && styles.textCompact,
          active && styles.activeText,
          more && styles.moreText,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    );
  }

  return (
    <View style={styles.wrapper}>
      <View
        style={[styles.container, isPhone && styles.containerCompact]}
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      >
        <TouchableOpacity
          style={[
            styles.chip,
            
            selected === null && styles.activeChip,
          ]}
          onPress={() => onSelect(null)}
        >
          {renderChipContent('All', selected === null, false)}
        </TouchableOpacity>

        {hasStore && (
          <TouchableOpacity
            style={[
              styles.chip,
              styles.storeChip,
              storeActive && styles.activeChip,
            ]}
            onPress={onStorePress}
          >
            {renderChipContent(storeLabel ?? 'Store', storeActive, false)}
          </TouchableOpacity>
        )}

        {visibleCategories.map((category) => (
          <TouchableOpacity
            key={category}
            style={[
              styles.chip,
              selected === category && styles.activeChip,
            ]}
            onPress={() => onSelect(category)}
          >
            {renderChipContent(category, selected === category, false)}
          </TouchableOpacity>
        ))}

        {hiddenCategories.length > 0 && (
          <View ref={moreButtonRef} collapsable={false}>
            <TouchableOpacity
              style={styles.chip}
              onPress={() => {
                moreButtonRef.current?.measure((x, y, width, height, pageX, pageY) => {
                  setMoreLayout({ x: pageX, y: pageY, width, height });
                  setDropdownVisible(true);
                });
              }}
            >
              {renderChipContent('More ▼', false, true)}
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Second row: listing sort. Compact chips so both rows together take
          roughly the space the single category row used to occupy. */}
      <View style={[styles.container, styles.sortRow, isPhone && styles.containerCompact]}>
        {SORT_OPTIONS.map(({ value, label }) => (
          <TouchableOpacity
            key={value}
            style={[
              styles.chip,
              sort === value && styles.activeChip,
            ]}
            onPress={() => onSortChange(value)}
          >
            {renderChipContent(label, sort === value, false)}
          </TouchableOpacity>
        ))}
      </View>

      {/* Offscreen pass to measure chip widths before deciding the split */}
      {!measured && (
        <View style={styles.measureRow} pointerEvents="none">
          <View onLayout={(e) => recordMeasurement('all', e)}>
            <View style={[styles.chip]}>
              {renderChipContent('All', false, false)}
            </View>
          </View>
          {hasStore && (
            <View onLayout={(e) => recordMeasurement('store', e)}>
              <View style={[styles.chip, styles.storeChip]}>
                {renderChipContent(storeLabel ?? 'Store', false, false)}
              </View>
            </View>
          )}
          {categories.map((category) => (
            <View key={category} onLayout={(e) => recordMeasurement(category, e)}>
              <View style={[styles.chip]}>
                {renderChipContent(category, false, false)}
              </View>
            </View>
          ))}
          <View onLayout={(e) => recordMeasurement('more', e)}>
            <View style={styles.chip}>
              {renderChipContent('More ▼', false, true)}
            </View>
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
                    <Text style={styles.checkmark}>✓</Text>
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
  containerCompact: {
    gap: spacing.sm,
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
  // Plain-text filter: no pill box or border, just the label with enough
  // padding that neighbouring filters read as separate items. The active
  // state is shown on the text itself (brand color + underline via
  // activeText), so the chip wrapper only centers its label for the width
  // measurement pass.
  chip: {
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  // Active-state marker lives on the text (see activeText); kept as an empty
  // style so existing conditional style arrays keep working.
  activeChip: {},
  storeChip: {
    maxWidth: 160,
  },
  text: {
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  textCompact: {
    fontSize: fontSizes.xs,
  },
  activeText: {
    color: colors.primary,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  moreText: {
    color: colors.primary,
    fontWeight: '600',
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
  checkmark: {
    color: colors.primary,
    fontWeight: '700',
    fontSize: fontSizes.md,
    marginLeft: spacing.sm,
  },
});
