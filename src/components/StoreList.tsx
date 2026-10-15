import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

/** A tenant shop as derived from the product catalog: one entry per owner. */
export interface StoreSummary {
  ownerId: string;
  shopName: string;
  logoUrl?: string;
  description?: string;
}

interface StoreListProps {
  stores: StoreSummary[];
  selectedOwnerId: string | null;
  onSelect: (ownerId: string | null) => void;
}

const LOGO_SIZE = 44;

/** Inline store picker shown on the home screen when the "Store" filter chip
 *  is tapped (replaces the product grid until a store is picked). One card
 *  per shop, styled like the order-history list: circular logo, shop name,
 *  product count, and a highlighted state for the current selection. */
export function StoreList({ stores, selectedOwnerId, onSelect }: StoreListProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  function renderLogo(logoUrl: string | undefined, icon: IconName) {
    if (logoUrl) {
      return (
        <Image
          source={{ uri: logoUrl }}
          style={{ width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: LOGO_SIZE / 2 }}
        />
      );
    }
    return (
      <View
        style={[
          styles.logoFallback,
          { width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: LOGO_SIZE / 2 },
        ]}
      >
        <Ionicons name={icon} size={22} color={colors.primary} />
      </View>
    );
  }

  function renderRow(
    ownerId: string | null,
    name: string,
    detail: string,
    logoUrl: string | undefined,
    icon: IconName,
  ) {
    const isSelected = ownerId === selectedOwnerId;
    return (
      <TouchableOpacity
        style={[styles.card, isSelected && styles.cardSelected]}
        activeOpacity={0.7}
        onPress={() => onSelect(ownerId)}
      >
        {renderLogo(logoUrl, icon)}
        <View style={styles.cardText}>
          <Text style={[styles.name, isSelected && styles.nameSelected]} numberOfLines={1}>
            {name}
          </Text>
          {detail ? (
            <Text style={styles.detail} numberOfLines={2}>
              {detail}
            </Text>
          ) : null}
        </View>
        {isSelected && (
          <View style={styles.check}>
            <Ionicons name="checkmark" size={16} color={colors.surface} />
          </View>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.list}>
      {renderRow(null, 'All Stores', 'Browse every shop', undefined, 'grid-outline')}
      {stores.map((store) =>
        renderRow(
          store.ownerId,
          store.shopName,
          store.description ?? '',
          store.logoUrl,
          'storefront-outline',
        ),
      )}
    </View>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    list: {
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.xl,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
    },
    cardSelected: {
      borderColor: colors.primary,
      borderWidth: 2,
    },
    cardText: {
      flex: 1,
    },
    name: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 2,
    },
    nameSelected: {
      color: colors.primary,
    },
    detail: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    logoFallback: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    check: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
    },
  });
