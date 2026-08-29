import { useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
  ScrollView,
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
}

export function CategoryFilter({
  selected,
  onSelect,
}: CategoryFilterProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const { categories } = useApp();
  const { isPhone } = useResponsive();
  const VISIBLE_COUNT = isPhone ? 5 : 3;
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const [moreLayout, setMoreLayout] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const moreButtonRef = useRef<View>(null);

  const visibleCategories = categories.slice(0, VISIBLE_COUNT);
  const hiddenCategories = categories.slice(VISIBLE_COUNT);

  function handleSelect(category: Category | null) {
    onSelect(category);
    setDropdownVisible(false);
  }

  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          styles.container,
          isPhone && styles.containerCompact,
        ]}
      >
        <TouchableOpacity
          style={[
            styles.chip,
            isPhone && styles.chipCompact,
            selected === null && styles.activeChip,
          ]}
          onPress={() => onSelect(null)}
        >
          <Text
            style={[
              styles.text,
              isPhone && styles.textCompact,
              selected === null && styles.activeText,
            ]}
          >
            All
          </Text>
        </TouchableOpacity>

        {visibleCategories.map((category) => (
          <TouchableOpacity
            key={category}
            style={[
              styles.chip,
              isPhone && styles.chipCompact,
              selected === category && styles.activeChip,
            ]}
            onPress={() => onSelect(category)}
          >
            <Text
              style={[
                styles.text,
                isPhone && styles.textCompact,
                selected === category && styles.activeText,
              ]}
            >
              {category}
            </Text>
          </TouchableOpacity>
        ))}

        {hiddenCategories.length > 0 && (
          <View ref={moreButtonRef} collapsable={false}>
            <TouchableOpacity
              style={[styles.chip, isPhone && styles.chipCompact, styles.moreChip]}
              onPress={() => {
                moreButtonRef.current?.measure((x, y, width, height, pageX, pageY) => {
                  setMoreLayout({ x: pageX, y: pageY, width, height });
                  setDropdownVisible(true);
                });
              }}
            >
              <Text
                style={[
                  styles.text,
                  isPhone && styles.textCompact,
                  styles.moreText,
                ]}
              >
                More ▼
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

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
              {categories.map((category) => (
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
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  container: {
    paddingHorizontal: 0,
    gap: spacing.sm,
    alignItems: 'center',
  },
  containerCompact: {
    paddingHorizontal: 0,
    gap: 2,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    height: 34,
    justifyContent: 'center',
  },
  chipCompact: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    height: 24,
  },
  activeChip: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  moreChip: {
    borderColor: colors.primary,
  },
  text: {
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  textCompact: {
    fontSize: fontSizes.xs,
  },
  activeText: {
    color: colors.surface,
    fontWeight: '600',
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
