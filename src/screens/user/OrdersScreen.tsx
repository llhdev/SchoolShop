import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { WebHeader } from '../../components/WebHeader';
import { useApp } from '../../context/AppContext';
import { formatPrice } from '../../utils/format';
import { getProductCoverImage } from '../../utils/images';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 900;

export function OrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { orders } = useApp();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const isWeb = Platform.OS === 'web';

  if (orders.length === 0) {
    return (
      <>
        {isWeb && <WebHeader showSearch={false} />}
        <Screen>
          <EmptyState message="No orders yet." icon="receipt-outline" />
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <WebHeader showSearch={false} />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>My Orders</Text>
          {isWeb && (
            <TouchableOpacity
              style={styles.homeLink}
              onPress={() => navigation.navigate('UserTabs', { screen: 'Home' })}
            >
              <Ionicons name="arrow-back" size={16} color={colors.primary} />
              <Text style={styles.homeLinkText}>Continue Shopping</Text>
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const firstItem = item.items[0];
            const imageUri = firstItem ? getProductCoverImage(firstItem.product) : '';
            const itemNames = item.items.map((i) => i.product.name).join(', ');

            return (
              <TouchableOpacity
                style={styles.card}
                onPress={() => navigation.navigate('OrderDetail', { orderId: item.id })}
              >
                <View style={styles.thumbnail}>
                  <Image source={{ uri: imageUri }} style={styles.thumbnailImage} resizeMode="contain" />
                </View>
                <View style={styles.info}>
                  <View style={styles.row}>
                    <Text style={styles.name} numberOfLines={1}>
                      {itemNames}
                    </Text>
                    <Text style={styles.price}>{formatPrice(item.total)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.date}>
                      {new Date(item.createdAt).toLocaleDateString()}
                    </Text>
                    <View
                      style={[
                        styles.badge,
                        item.status === 'paid' && styles.paidBadge,
                        item.status === 'pending' && styles.pendingBadge,
                        item.status === 'delivered' && styles.deliveredBadge,
                      ]}
                    >
                      <Text style={styles.badgeText}>{item.status}</Text>
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>
    </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  container: {
    flex: 1,
    maxWidth: MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  homeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  homeLinkText: {
    fontSize: fontSizes.md,
    color: colors.primary,
    fontWeight: '600',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...(Platform.OS === 'web'
      ? ({
          cursor: 'pointer',
        } as any)
      : {}),
  },
  thumbnail: {
    width: 64,
    height: 64,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    marginRight: spacing.md,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  info: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  name: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
    flex: 1,
    marginRight: spacing.sm,
  },
  price: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.primary,
  },
  date: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.border,
    marginLeft: spacing.sm,
  },
  pendingBadge: {
    backgroundColor: colors.warning,
  },
  paidBadge: {
    backgroundColor: colors.success,
  },
  deliveredBadge: {
    backgroundColor: colors.primary,
  },
  badgeText: {
    fontSize: fontSizes.xs,
    fontWeight: '600',
    color: colors.surface,
    textTransform: 'capitalize',
  },
});
