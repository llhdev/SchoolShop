import { Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Screen } from '../../components/Screen';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { useApp } from '../../context/AppContext';
import { formatPrice } from '../../utils/format';
import { getProductCoverImage } from '../../utils/images';
import { RootStackParamList } from '../../types/navigation';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 1000;

export function AdminUserOrdersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute();
  const { phoneNumber } = route.params as { phoneNumber: string };
  const { orders } = useApp();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const userOrders = orders
    .filter((order) => order.phoneNumber === phoneNumber)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const isWeb = Platform.OS === 'web';

  if (userOrders.length === 0) {
    return (
      <>
        {isWeb && <AdminHeader />}
        <Screen>
          <EmptyState message="No orders found for this user." icon="receipt-outline" />
        </Screen>
      </>
    );
  }

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <View style={styles.container}>
        <Text style={styles.phoneNumber}>{phoneNumber}</Text>
        <Text style={styles.subtitle}>{userOrders.length} order(s)</Text>

        <FlatList
          data={userOrders}
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
                <View style={styles.details}>
                  <View style={styles.header}>
                    <Text style={styles.total}>{formatPrice(item.total)}</Text>
                    <Text style={styles.date}>
                      {new Date(item.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <Text style={styles.itemNames} numberOfLines={2}>
                    {itemNames}
                  </Text>
                  <Text style={styles.paymentMethod}>
                    {item.paymentMethod === 'cash_on_delivery'
                      ? 'Cash on delivery'
                      : 'Online payment'}
                  </Text>
                </View>
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
  phoneNumber: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
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
  details: {
    flex: 1,
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  total: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.primary,
  },
  date: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  itemNames: {
    fontSize: fontSizes.sm,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  paymentMethod: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    textTransform: 'capitalize',
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
