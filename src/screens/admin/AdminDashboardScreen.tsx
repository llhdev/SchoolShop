import { useLayoutEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
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
import { ProductImage } from '../../components/ProductImage';
import { StatCard } from '../../components/StatCard';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { AdminStackParamList } from '../../types/navigation';
import { getProductCoverImage } from '../../utils/images';
import { confirmAction } from '../../utils/confirm';
import { notify } from '../../utils/notify';
import { formatPrice } from '../../utils/format';
import { useThemeColors, spacing, borderRadius, fontSizes, pageWidth, ColorPalette } from '../../constants/theme';
import { MERCHANT_ACCOUNT_EDITING_ENABLED } from '../../constants/featureFlags';

function AdminHeaderRight() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminStackParamList>>();
  const { signOutAdmin, role, staffSession, currentUserId } = useApp();
  const colors = useThemeColors();
  // The shop owner always gets the Account screen (it manages staff and
  // settings there, 048); staff accounts only when merchant editing is on.
  const isShopOwner = !!staffSession && staffSession.tenantId === currentUserId;

  return (
    <View style={headerRightStyles.container}>
      {(role === 'super_admin' || isShopOwner || MERCHANT_ACCOUNT_EDITING_ENABLED) && (
        <TouchableOpacity
          onPress={() => navigation.navigate('AdminAccount')}
          accessibilityLabel="Account and security"
        >
          <Ionicons name="person-circle-outline" size={24} color={colors.primary} />
        </TouchableOpacity>
      )}
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
  const { products, categories, deleteProduct, addCategory, removeCategory, role, staffSession, effectiveTenantId } = useApp();
  const isSuperAdmin = role === 'super_admin';
  // Staff roles (migration 045): only shop-capable accounts may add/edit/delete
  // items; the super admin and other staff see the catalog read-only.
  const canManageProducts = !!staffSession?.capabilities.shop;
  const visibleProducts = isSuperAdmin
    ? products
    : products.filter((p) => p.ownerId === effectiveTenantId);
  const { isDesktop, isPhone } = useResponsive();
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
      notify('Failed to delete item. Please try again.', 'error');
    }
  }

  async function handleAddCategory() {
    const trimmed = newCategory.trim();
    if (!trimmed) return;
    if (categories.includes(trimmed)) {
      notify(`${trimmed} already exists.`, 'info');
      return;
    }
    try {
      await addCategory(trimmed);
      setNewCategory('');
      setSuccessMessage('Category added');
      setTimeout(() => setSuccessMessage(null), 2000);
    } catch {
      notify('Failed to add category. Please try again.', 'error');
    }
  }

  async function handleRemoveCategory(category: string) {
    const inUse = visibleProducts.some((p) => p.category === category);
    if (inUse) {
      notify(
        'Some products are using this category. Reassign or delete those products first.',
        'info'
      );
      return;
    }
    try {
      await removeCategory(category);
      setSuccessMessage('Category removed');
      setTimeout(() => setSuccessMessage(null), 2000);
    } catch {
      notify('Failed to remove category. Please try again.', 'error');
    }
  }

  const isWeb = Platform.OS === 'web';

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen scroll noPadding edges={['left', 'right', 'bottom']}>
        <View style={styles.container}>
        <Text style={[styles.title, isPhone && styles.titleCompact]}>Dashboard</Text>
        <Text style={styles.subtitle}>
          {isSuperAdmin
            ? 'The platform catalog and categories across every shop.'
            : "Your shop's catalog."}
        </Text>
        {successMessage && (
          <View style={styles.successBanner}>
            <Text style={styles.successText}>{successMessage}</Text>
          </View>
        )}

        <View style={styles.headerRow}>
          <StatCard
            value={visibleProducts.length}
            label="Products"
            style={styles.headerStat}
          />
          {!isSuperAdmin && canManageProducts && (
            <View style={styles.actionButtonWrapper}>
              <Button
                title="Add New Item"
                onPress={() => navigation.navigate('AddEditItem')}
                style={styles.actionButton}
              />
            </View>
          )}
          {isSuperAdmin && (
            <View style={styles.actionButtonWrapper}>
              <Button
                title="Manage Tenants"
                onPress={() => navigation.navigate('TenantManagement')}
                variant="outline"
                style={styles.actionButton}
              />
            </View>
          )}
          <View style={styles.actionButtonWrapper}>
            <Button
              title="Shopper Analysis"
              onPress={() => navigation.navigate('AdminAnalysis')}
              variant="outline"
              style={styles.actionButton}
            />
          </View>
        </View>

        <View style={[styles.twoColumn, isDesktop && styles.twoColumnDesktop]}>
          {isSuperAdmin && (
            <View style={[styles.column, styles.categoriesColumn, styles.columnCard]}>
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
          )}

          <View style={[styles.column, styles.productsColumn, !isSuperAdmin && styles.productsColumnFullWidth]}>
            <Text style={styles.sectionTitle}>Manage Items</Text>
            {visibleProducts.length === 0 ? (
              <EmptyState
                message={isSuperAdmin ? 'No products yet.' : 'No products yet. Add your first item.'}
              />
            ) : (
              <View style={isDesktop ? styles.table : undefined}>
                {isDesktop && (
                  <View style={styles.tableHeader}>
                    <Text style={[styles.tableHeaderText, styles.colProduct]}>Product</Text>
                    <Text style={[styles.tableHeaderText, styles.colCategory]}>Category</Text>
                    <Text style={[styles.tableHeaderText, styles.colPrice]}>Price</Text>
                    {canManageProducts && (
                      <Text style={[styles.tableHeaderText, styles.colActions]}>Actions</Text>
                    )}
                  </View>
                )}
                {visibleProducts.map((item, index) => (
                  <View
                    key={item.id}
                    style={[
                      styles.productRow,
                      isDesktop && styles.productRowDesktop,
                      isDesktop && index === visibleProducts.length - 1 && styles.productRowLast,
                    ]}
                  >
                    <TouchableOpacity
                      style={[
                        styles.productInfoTouchable,
                        isDesktop && styles.productInfoTouchableDesktop,
                      ]}
                      onPress={() => navigation.navigate('AddEditItem', { productId: item.id })}
                      activeOpacity={canManageProducts ? 0.7 : 1}
                      disabled={!canManageProducts}
                    >
                      {!isDesktop && (
                        <View style={styles.mobileContent}>
                          <View style={styles.thumbnail}>
                            <ProductImage
                              uri={getProductCoverImage(item)}
                              category={item.category}
                              name={item.name}
                              thumbnail
                              style={styles.thumbnailImage}
                            />
                          </View>
                          <View style={styles.mobileText}>
                            <Text style={styles.productName} numberOfLines={1}>
                              {item.name}
                            </Text>
                            <Text style={styles.productMeta}>
                              {item.category} · <Text style={styles.productPrice}>{formatPrice(item.price)}</Text>
                            </Text>
                          </View>
                        </View>
                      )}

                      {isDesktop && (
                        <>
                          <View style={[styles.productCell, styles.colProduct, styles.productMain]}>
                            <View style={styles.thumbnail}>
                              <ProductImage
                                uri={getProductCoverImage(item)}
                                category={item.category}
                                name={item.name}
                                thumbnail
                                style={styles.thumbnailImage}
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
                            {formatPrice(item.price)}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>

                    {canManageProducts && item.ownerId === effectiveTenantId && (
                      <View style={[styles.productActions, isDesktop && styles.colActions]}>
                        <TouchableOpacity
                          style={[styles.iconButton, styles.deleteButton]}
                          onPress={() =>
                            confirmAction(
                              'Delete item?',
                              `Are you sure you want to delete "${item.name}"? This cannot be undone.`,
                              'Delete',
                              () => handleDelete(item.id)
                            )
                          }
                        >
                          <Ionicons name="trash-outline" size={18} color={colors.danger} />
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ))}
              </View>
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
      maxWidth: pageWidth.data,
      width: '100%',
      alignSelf: 'center',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
    },
    title: {
      fontSize: fontSizes.xxl,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.xs,
    },
    titleCompact: {
      fontSize: fontSizes.xl,
    },
    subtitle: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      marginBottom: spacing.md,
    },
    successBanner: {
      backgroundColor: colors.success,
      borderRadius: borderRadius.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      marginTop: spacing.xs,
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
      flexWrap: 'wrap',
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    // The stat card keeps its natural width; the buttons take the rest.
    headerStat: {
      flex: 0,
      paddingHorizontal: spacing.xl,
    },
    actionButtonWrapper: {
      flex: 1,
      minWidth: 150,
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
    // Categories column as a card, mirroring the bordered items table.
    columnCard: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
    },
    productsColumn: {
      flex: 2,
    },
    productsColumnFullWidth: {
      flex: 1,
      minWidth: '100%',
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
      ...(Platform.OS === 'web'
        ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
        : {}),
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
    // Desktop: header + rows in one bordered surface — the table look.
    table: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    tableHeader: {
      flexDirection: 'row',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: colors.background,
      borderBottomWidth: 1,
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
    productRowLast: {
      borderBottomWidth: 0,
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
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
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
      ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
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
