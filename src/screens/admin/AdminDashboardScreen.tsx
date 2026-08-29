import { useLayoutEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { AdminHeader } from '../../components/AdminHeader';
import { ThemeToggle } from '../../components/ThemeToggle';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { AdminStackParamList } from '../../types/navigation';
import { getProductCoverImage } from '../../utils/images';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';

const MAX_WIDTH = 1200;

function AdminHeaderRight() {
  const { signOutAdmin } = useApp();
  const colors = useThemeColors();

  return (
    <View style={headerRightStyles.container}>
      <ThemeToggle />
      <TouchableOpacity onPress={signOutAdmin}>
        <Text style={[headerRightStyles.text, { color: colors.danger }]}>
          Exit admin
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const headerRightStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginRight: spacing.sm,
  },
  text: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
  },
});

export function AdminDashboardScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminStackParamList>>();
  const { products, categories, deleteProduct, addCategory, removeCategory } = useApp();
  const { isDesktop } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');

  useLayoutEffect(() => {
    if (Platform.OS === 'web') return;
    navigation.setOptions({
      headerRight: () => <AdminHeaderRight />,
    });
  }, [navigation]);

  async function handleDelete(id: string) {
    try {
      await deleteProduct(id);
      setSuccessMessage('Item deleted successfully');
      setTimeout(() => setSuccessMessage(null), 2000);
    } catch {
      Alert.alert('Error', 'Failed to delete item. Please try again.');
    }
  }

  async function handleAddCategory() {
    const trimmed = newCategory.trim();
    if (!trimmed) return;
    if (categories.includes(trimmed)) {
      Alert.alert('Duplicate', `${trimmed} already exists.`);
      return;
    }
    try {
      await addCategory(trimmed);
      setNewCategory('');
      setSuccessMessage('Category added');
      setTimeout(() => setSuccessMessage(null), 2000);
    } catch {
      Alert.alert('Error', 'Failed to add category. Please try again.');
    }
  }

  async function handleRemoveCategory(category: string) {
    const inUse = products.some((p) => p.category === category);
    if (inUse) {
      Alert.alert(
        'Cannot delete',
        'Some products are using this category. Reassign or delete those products first.'
      );
      return;
    }
    try {
      await removeCategory(category);
      setSuccessMessage('Category removed');
      setTimeout(() => setSuccessMessage(null), 2000);
    } catch {
      Alert.alert('Error', 'Failed to remove category. Please try again.');
    }
  }

  const isWeb = Platform.OS === 'web';

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen scroll noPadding edges={['left', 'right']}>
        <View style={styles.container}>
        {successMessage && (
          <View style={styles.successBanner}>
            <Text style={styles.successText}>{successMessage}</Text>
          </View>
        )}

        <View style={styles.headerRow}>
          <View style={[styles.statCard, isDesktop && styles.statCardDesktop]}>
            <Text style={styles.statValue}>{products.length}</Text>
            <Text style={styles.statLabel}>Products</Text>
          </View>
          <View style={styles.actionButtonWrapper}>
            <Button
              title="Add New Item"
              onPress={() => navigation.navigate('AddEditItem')}
              style={styles.actionButton}
            />
          </View>
        </View>

        <View style={[styles.twoColumn, isDesktop && styles.twoColumnDesktop]}>
          <View style={[styles.column, styles.categoriesColumn]}>
            <Text style={styles.sectionTitle}>Manage Categories</Text>
            <View style={styles.categoryInputRow}>
              <TextInput
                style={styles.categoryInput}
                value={newCategory}
                onChangeText={setNewCategory}
                placeholder="New category name"
                placeholderTextColor={colors.textSecondary}
              />
              <TouchableOpacity style={styles.categoryAddButton} onPress={handleAddCategory}>
                <Ionicons name="add-outline" size={24} color={colors.surface} />
              </TouchableOpacity>
            </View>
            <View style={styles.categoryList}>
              {categories.map((category) => (
                <View key={category} style={styles.categoryChip}>
                  <Text style={styles.categoryChipText} numberOfLines={1}>
                    {category}
                  </Text>
                  <TouchableOpacity
                    style={styles.categoryDelete}
                    onPress={() => handleRemoveCategory(category)}
                  >
                    <Ionicons name="close-outline" size={16} color={colors.danger} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          </View>

          <View style={[styles.column, styles.productsColumn]}>
            <Text style={styles.sectionTitle}>Manage Items</Text>
            {products.length === 0 ? (
              <EmptyState message="No products yet. Add your first item." />
            ) : (
              <>
                {isDesktop && (
                  <View style={styles.tableHeader}>
                    <Text style={[styles.tableHeaderText, styles.colProduct]}>Product</Text>
                    <Text style={[styles.tableHeaderText, styles.colCategory]}>Category</Text>
                    <Text style={[styles.tableHeaderText, styles.colPrice]}>Price</Text>
                    <Text style={[styles.tableHeaderText, styles.colActions]}>Actions</Text>
                  </View>
                )}
                <FlatList
                  data={products}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                  renderItem={({ item }) => (
                    <View style={[styles.productRow, isDesktop && styles.productRowDesktop]}>
                      <TouchableOpacity
                        style={[
                          styles.productInfoTouchable,
                          isDesktop && styles.productInfoTouchableDesktop,
                        ]}
                        onPress={() => navigation.navigate('AddEditItem', { productId: item.id })}
                        activeOpacity={0.7}
                      >
                        {!isDesktop && (
                          <View style={styles.mobileContent}>
                            <View style={styles.thumbnail}>
                              <Image
                                source={{ uri: getProductCoverImage(item) }}
                                style={styles.thumbnailImage}
                                resizeMode="contain"
                              />
                            </View>
                            <View style={styles.mobileText}>
                              <Text style={styles.productName} numberOfLines={1}>
                                {item.name}
                              </Text>
                              <Text style={styles.productMeta}>
                                {item.category} · <Text style={styles.productPrice}>${item.price.toFixed(2)}</Text>
                              </Text>
                            </View>
                          </View>
                        )}

                        {isDesktop && (
                          <>
                            <View style={[styles.productCell, styles.colProduct, styles.productMain]}>
                              <View style={styles.thumbnail}>
                                <Image
                                  source={{ uri: getProductCoverImage(item) }}
                                  style={styles.thumbnailImage}
                                  resizeMode="contain"
                                />
                              </View>
                              <Text style={styles.productName} numberOfLines={1}>
                                {item.name}
                              </Text>
                            </View>
                            <Text style={[styles.productCellText, styles.colCategory]}>
                              {item.category}
                            </Text>
                            <Text style={[styles.productCellText, styles.colPrice]}>
                              ${item.price.toFixed(2)}
                            </Text>
                          </>
                        )}
                      </TouchableOpacity>

                      <View style={[styles.productActions, isDesktop && styles.colActions]}>
                        <TouchableOpacity
                          style={[styles.iconButton, styles.deleteButton]}
                          onPress={() => handleDelete(item.id)}
                        >
                          <Ionicons name="trash-outline" size={18} color={colors.danger} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                />
              </>
            )}
          </View>
        </View>
      </View>
    </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      maxWidth: MAX_WIDTH,
      width: '100%',
      alignSelf: 'center',
      paddingHorizontal: spacing.lg,
      paddingTop: 0,
      paddingBottom: spacing.md,
    },
    successBanner: {
      backgroundColor: colors.success,
      borderRadius: borderRadius.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.md,
    },
    successText: {
      color: colors.surface,
      fontSize: fontSizes.md,
      fontWeight: '600',
      textAlign: 'center',
    },

    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    statCard: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statCardDesktop: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.xl,
    },
    statValue: {
      fontSize: fontSizes.xl,
      fontWeight: '700',
      color: colors.primary,
    },
    statLabel: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    actionButtonWrapper: {
      flex: 1,
    },
    actionButton: {
      width: '100%',
    },
    twoColumn: {
      gap: spacing.md,
    },
    twoColumnDesktop: {
      flexDirection: 'row',
    },
    column: {
      flex: 1,
    },
    categoriesColumn: {
      ...(Platform.OS === 'web'
        ? ({
            maxWidth: 360,
          } as any)
        : {}),
    },
    productsColumn: {
      flex: 2,
    },
    sectionTitle: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.sm,
      marginTop: spacing.sm,
    },
    categoryInputRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    categoryInput: {
      flex: 1,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSizes.md,
      color: colors.text,
    },
    categoryAddButton: {
      width: 44,
      height: 44,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
    },
    categoryList: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    categoryChip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.xl,
      paddingLeft: spacing.sm,
      paddingRight: spacing.xs,
      paddingVertical: spacing.xs,
      gap: spacing.xs,
    },
    categoryChipText: {
      fontSize: fontSizes.xs,
      color: colors.text,
      maxWidth: 160,
    },
    categoryDelete: {
      padding: spacing.xs,
    },
    tableHeader: {
      flexDirection: 'row',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: colors.background,
      borderTopLeftRadius: borderRadius.md,
      borderTopRightRadius: borderRadius.md,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: colors.border,
    },
    tableHeaderText: {
      fontSize: fontSizes.sm,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    productRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderBottomWidth: 1,
      borderColor: colors.border,
    },
    productRowDesktop: {
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
      borderBottomWidth: 1,
      borderColor: colors.border,
    },
    productCell: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    productMain: {
      gap: spacing.sm,
    },
    productName: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    productMeta: {
      fontSize: fontSizes.xs,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    productPrice: {
      fontWeight: '700',
      color: colors.text,
    },
    productCellText: {
      fontSize: fontSizes.xs,
      color: colors.text,
    },
    thumbnail: {
      width: 36,
      height: 36,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
    },
    thumbnailImage: {
      width: '100%',
      height: '100%',
    },
    productInfoTouchable: {
      flex: 1,
      flexDirection: 'column',
      justifyContent: 'center',
    },
    productInfoTouchableDesktop: {
      flex: 7,
      flexDirection: 'row',
      alignItems: 'center',
    },
    mobileContent: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    mobileText: {
      flex: 1,
    },
    productActions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    iconButton: {
      minWidth: 32,
      minHeight: 32,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: borderRadius.sm,
      borderWidth: 1,
    },
    deleteButton: {
      backgroundColor: colors.dangerLight,
      borderColor: colors.danger,
    },
    colProduct: {
      flex: 3,
    },
    colCategory: {
      flex: 2,
    },
    colPrice: {
      flex: 1,
    },
    colActions: {
      flex: 1.5,
      justifyContent: 'flex-end',
    },
  });
