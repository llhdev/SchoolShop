import { Dispatch, SetStateAction, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/Button';
import { AdminHeader } from '../../components/AdminHeader';
import { ProductImage } from '../../components/ProductImage';
import { useApp } from '../../context/AppContext';
import { useResponsive } from '../../hooks/useResponsive';
import { AdminStackParamList } from '../../types/navigation';
import { getProductCoverImage, resizeImage } from '../../utils/images';
import { deleteProductImage, uploadProductImages } from '../../services/images';
import { fetchOwnProfile, updateOwnShippingFee } from '../../services/account';
import { Category, CheckoutField, Product, VariantGroup, VariantOption } from '../../types';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../../constants/theme';
import { MERCHANT_ACCOUNT_EDITING_ENABLED } from '../../constants/featureFlags';

const MAX_WIDTH = 800;

/** Editing state for the variations section — prices stay strings while
 *  typing and are parsed/validated on save. */
interface OptionEdit {
  name: string;
  price: string;
  imageIndex?: number;
}
interface GroupEdit {
  name: string;
  affectsPrice: boolean;
  options: OptionEdit[];
}

function toGroupEdits(groups: VariantGroup[] | undefined): GroupEdit[] {
  return (groups ?? []).map((g) => ({
    name: g.name,
    affectsPrice: g.affectsPrice,
    options: g.options.map((o) => ({
      name: o.name,
      price: o.price !== undefined ? String(o.price) : '',
      imageIndex: o.imageIndex,
    })),
  }));
}

/** Editing state for the checkout questions section. */
interface FieldEdit {
  label: string;
  type: 'text' | 'dropdown';
  required: boolean;
  /** dropdown only: choice rows while editing. */
  options: string[];
}

function toFieldEdits(fields: CheckoutField[] | undefined): FieldEdit[] {
  return (fields ?? []).map((f) => ({
    label: f.label,
    type: f.type,
    required: f.required,
    options: f.options ?? [],
  }));
}

export function AddEditItemScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminStackParamList>>();
  const route = useRoute();
  const { productId } = (route.params as { productId?: string }) ?? {};
  const { products, categories, addProduct, updateProduct, role, currentUserId } = useApp();
  const { isDesktop, isPhone } = useResponsive();
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const existing = productId ? products.find((p) => p.id === productId) : undefined;
  const isSuperAdmin = role === 'super_admin';
  const canEditExisting =
    !existing || isSuperAdmin || existing.ownerId === currentUserId;

  const [name, setName] = useState(existing?.name ?? '');
  const [price, setPrice] = useState(existing?.price.toString() ?? '');
  const [compareAtPrice, setCompareAtPrice] = useState(
    existing?.compareAtPrice?.toString() ?? ''
  );
  // "Price on request": no price tag, order via chat only (migration 029).
  const [priceOnRequest, setPriceOnRequest] = useState(existing?.priceHidden ?? false);
  const [category, setCategory] = useState<Category>(existing?.category ?? categories[0] ?? '');
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [images, setImages] = useState<string[]>(existing?.images ?? []);
  const [detailImages, setDetailImages] = useState<string[]>(existing?.detailImages ?? []);
  const [description, setDescription] = useState(existing?.description ?? '');
  const [coverImageIndex, setCoverImageIndex] = useState(existing?.coverImageIndex ?? 0);
  // The shop's flat shipping fee (profiles.shipping_fee, migration 031) —
  // editable here for convenience; it applies to the whole shop, not the item.
  const [shippingFee, setShippingFee] = useState('');
  const [loadedShippingFee, setLoadedShippingFee] = useState<number | null>(null);
  // Variant groups ("Size", "Color"…); at most one group sets the price.
  const [variantGroups, setVariantGroups] = useState<GroupEdit[]>(() =>
    toGroupEdits(existing?.variantGroups)
  );
  /** "groupIndex:optionIndex" of the option whose photo picker strip is open. */
  const [photoPickerFor, setPhotoPickerFor] = useState<string | null>(null);
  // Checkout questions ("Campus branch", "ID number"…) the buyer answers at checkout.
  const [checkoutFields, setCheckoutFields] = useState<FieldEdit[]>(() =>
    toFieldEdits(existing?.checkoutFields)
  );

  useEffect(() => {
    if (role !== 'admin' || !MERCHANT_ACCOUNT_EDITING_ENABLED) return;
    fetchOwnProfile()
      .then((own) => {
        const fee = own?.shippingFee ?? null;
        setLoadedShippingFee(fee);
        setShippingFee(fee ? String(Math.round(fee)) : '');
      })
      .catch(() => {
        // The field stays editable; a failed load just means no pre-fill.
      });
  }, [role]);

  useEffect(() => {
    if (categories.length === 0 && !existing) {
      Alert.alert(
        'No categories',
        'Please add a category in the admin dashboard before creating a product.',
        [{ text: 'OK', onPress: () => navigation.navigate('AdminDashboard') }]
      );
    }
  }, [categories.length, existing, navigation]);

  useEffect(() => {
    if (existing && !canEditExisting) {
      Alert.alert('Access denied', 'You can only edit products you uploaded.', [
        { text: 'OK', onPress: () => navigation.navigate('AdminDashboard') },
      ]);
    }
  }, [existing, canEditExisting, navigation]);

  // The super admin manages the platform but never posts items.
  useEffect(() => {
    if (!existing && isSuperAdmin) {
      Alert.alert('Not available', 'Only tenant admins can add items.', [
        { text: 'OK', onPress: () => navigation.navigate('AdminDashboard') },
      ]);
    }
  }, [existing, isSuperAdmin, navigation]);

  const compareAt = priceOnRequest ? undefined : compareAtPrice.trim() ? Number(compareAtPrice) : undefined;
  const isValid =
    name.trim() &&
    (priceOnRequest || (!isNaN(Number(price)) && Number(price) > 0)) &&
    (priceOnRequest || compareAt === undefined || (!isNaN(compareAt) && compareAt > Number(price))) &&
    category.trim().length > 0;

  function togglePriceOnRequest() {
    setPriceOnRequest((prev) => {
      if (!prev) {
        setPrice('');
        setCompareAtPrice('');
      }
      return !prev;
    });
  }

  async function pickImages(append: Dispatch<SetStateAction<string[]>>) {
    // Web (browser + Telegram Mini App WebView): hidden file input + canvas
    // resize. expo-image-picker does not run in a WebView.
    if (Platform.OS === 'web') {
      const { pickImagesWeb } = await import('../../lib/image-web');
      const uris = await pickImagesWeb();
      if (uris.length > 0) {
        const resized = await Promise.all(
          uris.map((uri) => resizeImage(uri, 800))
        );
        const uploaded = await uploadProductImages(resized);
        append((prev) => [...prev, ...uploaded]);
      }
      return;
    }

    // Native: dynamically imported so the module stays out of the web bundle.
    const ImagePicker = await import('expo-image-picker');
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      allowsMultipleSelection: true,
      quality: 0.8,
    });

    if (!result.canceled && result.assets.length > 0) {
      const resized = await Promise.all(
        result.assets.map((asset) => resizeImage(asset.uri, 800))
      );
      const uploaded = await uploadProductImages(resized);
      append((prev) => [...prev, ...uploaded]);
    }
  }

  function removeDetailImage(index: number) {
    const removed = detailImages[index];
    setDetailImages((prev) => prev.filter((_, i) => i !== index));
    // Best-effort cleanup of the storage object.
    deleteProductImage(removed).catch(() => {});
  }

  function removeImage(index: number) {
    const removed = images[index];
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setCoverImageIndex((current) => {
        if (current >= next.length) return next.length > 0 ? next.length - 1 : 0;
        return current;
      });
      return next;
    });
    // Best-effort cleanup of the storage object.
    deleteProductImage(removed).catch(() => {});
  }

  function updateGroup(gi: number, patch: Partial<GroupEdit>) {
    setVariantGroups((prev) => prev.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  }

  function removeGroup(gi: number) {
    setVariantGroups((prev) => prev.filter((_, i) => i !== gi));
  }

  function addGroup() {
    setVariantGroups((prev) => [
      ...prev,
      // The first group defaults to setting the price; later groups don't.
      { name: '', affectsPrice: !prev.some((g) => g.affectsPrice), options: [] },
    ]);
  }

  /** Radio behavior: at most one price group. */
  function togglePriceGroup(gi: number) {
    setVariantGroups((prev) =>
      prev.map((g, i) => ({ ...g, affectsPrice: i === gi ? !g.affectsPrice : false }))
    );
  }

  function addOption(gi: number) {
    setVariantGroups((prev) =>
      prev.map((g, i) =>
        i === gi ? { ...g, options: [...g.options, { name: '', price: '' }] } : g
      )
    );
  }

  function updateOption(gi: number, oi: number, patch: Partial<OptionEdit>) {
    setVariantGroups((prev) =>
      prev.map((g, i) =>
        i === gi
          ? { ...g, options: g.options.map((o, j) => (j === oi ? { ...o, ...patch } : o)) }
          : g
      )
    );
  }

  function removeOption(gi: number, oi: number) {
    setVariantGroups((prev) =>
      prev.map((g, i) =>
        i === gi ? { ...g, options: g.options.filter((_, j) => j !== oi) } : g
      )
    );
  }

  /** Validate + convert the editing state into stored variant groups. */
  function buildVariants(): { groups?: VariantGroup[]; error?: string } {
    const groups: VariantGroup[] = [];
    const seenGroups = new Set<string>();
    for (const g of variantGroups) {
      const groupName = g.name.trim();
      const options = g.options.filter((o) => o.name.trim().length > 0);
      // Untouched empty group (no name, no options) is dropped silently.
      if (!groupName && options.length === 0) continue;
      if (!groupName) return { error: 'Every variation group needs a name (e.g. Size).' };
      const groupKey = groupName.toLowerCase();
      if (seenGroups.has(groupKey)) return { error: `Duplicate group name "${groupName}".` };
      seenGroups.add(groupKey);
      if (options.length === 0) return { error: `Add at least one option to "${groupName}".` };
      const seenOptions = new Set<string>();
      const builtOptions: VariantOption[] = [];
      for (const o of options) {
        const optionName = o.name.trim();
        const optionKey = optionName.toLowerCase();
        if (seenOptions.has(optionKey)) {
          return { error: `Duplicate option "${optionName}" in ${groupName}.` };
        }
        seenOptions.add(optionKey);
        let optionPrice: number | undefined;
        if (g.affectsPrice) {
          const parsed = Number(o.price);
          if (!o.price.trim() || !Number.isFinite(parsed) || parsed < 0) {
            return { error: `Enter a price for "${optionName}" — ${groupName} sets the price.` };
          }
          optionPrice = parsed;
        }
        builtOptions.push({ name: optionName, price: optionPrice, imageIndex: o.imageIndex });
      }
      groups.push({ name: groupName, affectsPrice: g.affectsPrice, options: builtOptions });
    }
    return { groups: groups.length > 0 ? groups : undefined };
  }

  function updateField(fi: number, patch: Partial<FieldEdit>) {
    setCheckoutFields((prev) => prev.map((f, i) => (i === fi ? { ...f, ...patch } : f)));
  }

  function removeField(fi: number) {
    setCheckoutFields((prev) => prev.filter((_, i) => i !== fi));
  }

  function addField() {
    setCheckoutFields((prev) => [
      ...prev,
      { label: '', type: 'text', required: true, options: [] },
    ]);
  }

  function addFieldOption(fi: number) {
    setCheckoutFields((prev) =>
      prev.map((f, i) => (i === fi ? { ...f, options: [...f.options, ''] } : f))
    );
  }

  function updateFieldOption(fi: number, oi: number, text: string) {
    setCheckoutFields((prev) =>
      prev.map((f, i) =>
        i === fi ? { ...f, options: f.options.map((o, j) => (j === oi ? text : o)) } : f
      )
    );
  }

  function removeFieldOption(fi: number, oi: number) {
    setCheckoutFields((prev) =>
      prev.map((f, i) =>
        i === fi ? { ...f, options: f.options.filter((_, j) => j !== oi) } : f
      )
    );
  }

  /** Validate + convert the editing state into stored checkout questions. */
  function buildCheckoutFields(): { fields?: CheckoutField[]; error?: string } {
    const fields: CheckoutField[] = [];
    const seenLabels = new Set<string>();
    for (const f of checkoutFields) {
      const label = f.label.trim();
      const options = f.options.map((o) => o.trim()).filter((o) => o.length > 0);
      // Untouched empty question (no label, no options) is dropped silently.
      if (!label && options.length === 0) continue;
      if (!label) return { error: 'Every checkout question needs a label (e.g. ID number).' };
      const labelKey = label.toLowerCase();
      if (seenLabels.has(labelKey)) return { error: `Duplicate question "${label}".` };
      seenLabels.add(labelKey);
      if (f.type === 'dropdown') {
        if (options.length < 2) {
          return { error: `Add at least two choices to "${label}" (dropdown).` };
        }
        const seenOptions = new Set<string>();
        for (const o of options) {
          const optionKey = o.toLowerCase();
          if (seenOptions.has(optionKey)) {
            return { error: `Duplicate choice "${o}" in ${label}.` };
          }
          seenOptions.add(optionKey);
        }
      }
      fields.push({
        label,
        type: f.type,
        required: f.required,
        ...(f.type === 'dropdown' ? { options } : {}),
      });
    }
    return { fields: fields.length > 0 ? fields : undefined };
  }

  async function handleSave() {
    if (!isValid) return;
    if (!existing && isSuperAdmin) return;

    const variants = buildVariants();
    if (variants.error) {
      Alert.alert('Check variations', variants.error);
      return;
    }
    const questions = buildCheckoutFields();
    if (questions.error) {
      Alert.alert('Check questions', questions.error);
      return;
    }

    const productData: Product = {
      id: existing?.id ?? Date.now().toString(),
      name: name.trim(),
      description: description.trim(),
      price: priceOnRequest ? 0 : Number(price),
      compareAtPrice: priceOnRequest ? undefined : compareAt,
      priceHidden: priceOnRequest,
      category,
      images,
      detailImages,
      coverImageIndex: images.length > 0 ? coverImageIndex : 0,
      variantGroups: priceOnRequest ? undefined : variants.groups,
      checkoutFields: questions.fields,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ownerId: existing?.ownerId ?? currentUserId ?? undefined,
    };

    try {
      if (existing) {
        await updateProduct(productData);
        Alert.alert('Item Updated', `${productData.name} has been updated.`);
      } else {
        await addProduct(productData);
        Alert.alert('Item Added', `${productData.name} has been added.`);
      }
      // Persist the shop's shipping fee when the tenant changed it here.
      // Kept separate from the product save so a fee failure never blocks
      // the item itself.
      if (role === 'admin' && MERCHANT_ACCOUNT_EDITING_ENABLED) {
        const trimmed = shippingFee.trim();
        const fee = trimmed === '' ? null : Number(trimmed);
        if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
          Alert.alert('Note', 'The shipping fee was not saved — enter a valid number in Birr.');
        } else {
          const nextFee = fee && fee > 0 ? fee : null;
          if (nextFee !== loadedShippingFee) {
            try {
              await updateOwnShippingFee(nextFee);
            } catch {
              Alert.alert(
                'Note',
                'The item was saved, but the shipping fee could not be saved. Set it in Account & Security.'
              );
            }
          }
        }
      }
      navigation.navigate('AdminDashboard');
    } catch {
      Alert.alert('Error', 'Failed to save item. Please check your connection and try again.');
    }
  }

  const previewProduct: Product = {
    id: existing?.id ?? 'preview',
    name: name.trim() || 'Product',
    description: description.trim(),
    price: Number(price) || 0,
    priceHidden: priceOnRequest,
    category,
    images,
    detailImages,
    coverImageIndex,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  const coverUri = getProductCoverImage(previewProduct);
  const isWeb = Platform.OS === 'web';

  return (
    <>
      {isWeb && <AdminHeader />}
      <Screen noPadding edges={['top', 'left', 'right']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.container}>
          <Text style={[styles.title, isPhone && styles.titleCompact]}>
            {existing ? 'Edit Item' : 'Add New Item'}
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Product Images</Text>
            <TouchableOpacity
              style={[
                styles.coverPicker,
                images.length > 0 && styles.coverPickerWithImage,
              ]}
              onPress={() => pickImages(setImages)}
            >
              <ProductImage uri={coverUri} category={category} name={name} style={styles.coverImage} />
              <View
                style={[
                  styles.imageOverlay,
                  images.length > 0 && styles.imageOverlaySubtle,
                ]}
              >
                <Ionicons
                  name="camera-outline"
                  size={28}
                  color={images.length > 0 ? colors.primary : colors.surface}
                />
                <Text
                  style={[
                    styles.imageOverlayText,
                    images.length > 0 && styles.imageOverlayTextDark,
                  ]}
                >
                  {images.length > 0 ? 'Add More Images' : 'Add Images'}
                </Text>
              </View>
            </TouchableOpacity>

            {images.length > 0 && (
              <FlatList
                data={images}
                horizontal
                keyExtractor={(_, index) => index.toString()}
                contentContainerStyle={styles.thumbnailList}
                showsHorizontalScrollIndicator={false}
                renderItem={({ item, index }) => (
                  <View
                    style={[
                      styles.thumbnailContainer,
                      index === coverImageIndex && styles.thumbnailContainerActive,
                    ]}
                  >
                    <TouchableOpacity onPress={() => setCoverImageIndex(index)}>
                      <ProductImage uri={item} category={category} name={name} style={styles.thumbnail} contentFit="cover" />
                    </TouchableOpacity>
                    {index === coverImageIndex && (
                      <View style={styles.coverBadge}>
                        <Text style={styles.coverBadgeText}>Cover</Text>
                      </View>
                    )}
                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => removeImage(index)}
                    >
                      <Ionicons name="close-circle" size={22} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
          </View>

          <View style={[styles.row, isDesktop && styles.rowDesktop]}>
            <View style={[styles.field, isDesktop && styles.flex]}>
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Item name"
              />
            </View>

            <View style={[styles.field, isDesktop && styles.flex]}>
              <Text style={styles.label}>Category</Text>
              <TouchableOpacity
                style={styles.dropdownField}
                onPress={() => setCategoryOpen((open) => !open)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.dropdownValue, !category && styles.dropdownValuePlaceholder]}
                  numberOfLines={1}
                >
                  {category || 'Select a category'}
                </Text>
                <Ionicons
                  name={categoryOpen ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
              {categoryOpen && (
                <ScrollView
                  style={styles.dropdownList}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                >
                  {categories.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[
                        styles.dropdownOption,
                        cat === category && styles.dropdownOptionActive,
                      ]}
                      onPress={() => {
                        setCategory(cat);
                        setCategoryOpen(false);
                      }}
                    >
                      <Text
                        style={[
                          styles.dropdownOptionText,
                          cat === category && styles.dropdownOptionTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {cat}
                      </Text>
                      {cat === category && (
                        <Ionicons name="checkmark" size={16} color={colors.primary} />
                      )}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Detail Images (optional)</Text>
            <Text style={styles.detailHint}>
              Extra photos such as size charts or labels, shown under the description.
            </Text>
            <View style={styles.detailGrid}>
              {detailImages.map((uri, index) => (
                <View key={`${uri}-${index}`} style={styles.thumbnailContainer}>
                  <ProductImage
                    uri={uri}
                    category={category}
                    name={name}
                    style={styles.thumbnail}
                    contentFit="cover"
                  />
                  <TouchableOpacity
                    style={styles.removeButton}
                    onPress={() => removeDetailImage(index)}
                  >
                    <Ionicons name="close-circle" size={22} color={colors.danger} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity
                style={[styles.thumbnailContainer, styles.detailAddTile]}
                onPress={() => pickImages(setDetailImages)}
              >
                <Ionicons name="add-outline" size={28} color={colors.primary} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Description</Text>
            <TextInput
              style={[styles.input, styles.descriptionInput]}
              value={description}
              onChangeText={setDescription}
              placeholder="Describe the product..."
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          <TouchableOpacity
            style={styles.toggleRow}
            onPress={togglePriceOnRequest}
            activeOpacity={0.7}
          >
            <Ionicons
              name={priceOnRequest ? 'checkbox' : 'square-outline'}
              size={22}
              color={priceOnRequest ? colors.primary : colors.textSecondary}
            />
            <View style={styles.toggleText}>
              <Text style={styles.toggleLabel}>Price on request</Text>
              <Text style={styles.toggleHint}>
                No price tag. Shoppers can only chat with you to order (e.g. ID cards, custom items).
              </Text>
            </View>
          </TouchableOpacity>

          {!priceOnRequest && (
            <View style={[styles.row, isDesktop && styles.rowDesktop]}>
              <View style={[styles.field, isDesktop && styles.flex]}>
                <Text style={styles.label}>Price (ETB)</Text>
                <TextInput
                  style={styles.input}
                  value={price}
                  onChangeText={setPrice}
                  placeholder="0"
                  keyboardType="decimal-pad"
                />
              </View>

              <View style={[styles.field, isDesktop && styles.flex]}>
                <Text style={styles.label}>Original Price (ETB, optional)</Text>
                <TextInput
                  style={styles.input}
                  value={compareAtPrice}
                  onChangeText={setCompareAtPrice}
                  placeholder="Higher than sale price"
                  keyboardType="decimal-pad"
                />
              </View>
            </View>
          )}

          {!priceOnRequest && (
            <View style={styles.field}>
              <Text style={styles.label}>Variations (optional)</Text>
              <Text style={styles.detailHint}>
                Add groups like Size or Color. The group marked "sets the price" gives
                each of its options its own price — shoppers pick one option per group.
              </Text>
              {variantGroups.map((group, gi) => (
                <View key={gi} style={styles.variantGroupCard}>
                  <View style={styles.variantGroupHeader}>
                    <TextInput
                      style={[styles.input, styles.variantGroupName]}
                      value={group.name}
                      onChangeText={(text) => updateGroup(gi, { name: text })}
                      placeholder="Group name (e.g. Size, Color)"
                    />
                    <TouchableOpacity onPress={() => removeGroup(gi)} style={styles.variantDelete}>
                      <Ionicons name="trash-outline" size={20} color={colors.danger} />
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity
                    style={styles.variantPriceToggle}
                    onPress={() => togglePriceGroup(gi)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={group.affectsPrice ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={group.affectsPrice ? colors.primary : colors.textSecondary}
                    />
                    <Text style={styles.variantToggleText}>This group sets the price</Text>
                  </TouchableOpacity>

                  {group.options.map((option, oi) => {
                    const pickerKey = `${gi}:${oi}`;
                    const linkedImage =
                      option.imageIndex !== undefined ? images[option.imageIndex] : undefined;
                    return (
                      <View key={oi} style={styles.optionBlock}>
                        <View style={styles.optionRow}>
                          <TextInput
                            style={[styles.input, styles.optionNameInput]}
                            value={option.name}
                            onChangeText={(text) => updateOption(gi, oi, { name: text })}
                            placeholder={group.affectsPrice ? 'e.g. Black' : 'e.g. 42-43'}
                          />
                          {group.affectsPrice && (
                            <TextInput
                              style={[styles.input, styles.optionPriceInput]}
                              value={option.price}
                              onChangeText={(text) => updateOption(gi, oi, { price: text })}
                              placeholder="Price"
                              keyboardType="decimal-pad"
                            />
                          )}
                          {images.length > 0 && (
                            <TouchableOpacity
                              style={styles.optionPhotoButton}
                              onPress={() =>
                                setPhotoPickerFor((cur) => (cur === pickerKey ? null : pickerKey))
                              }
                            >
                              {linkedImage ? (
                                <ProductImage
                                  uri={linkedImage}
                                  category={category}
                                  name={name}
                                  style={styles.optionPhotoThumb}
                                  contentFit="cover"
                                />
                              ) : (
                                <Ionicons
                                  name="image-outline"
                                  size={20}
                                  color={colors.textSecondary}
                                />
                              )}
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            onPress={() => removeOption(gi, oi)}
                            style={styles.variantDelete}
                          >
                            <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                          </TouchableOpacity>
                        </View>
                        {photoPickerFor === pickerKey && images.length > 0 && (
                          <View style={styles.optionPhotoStrip}>
                            <Text style={styles.detailHint}>
                              Link one of the product photos to this option (tap again to unlink):
                            </Text>
                            <View style={styles.optionPhotoChoices}>
                              {images.map((uri, imgIdx) => (
                                <TouchableOpacity
                                  key={imgIdx}
                                  onPress={() =>
                                    updateOption(gi, oi, {
                                      imageIndex: option.imageIndex === imgIdx ? undefined : imgIdx,
                                    })
                                  }
                                >
                                  <ProductImage
                                    uri={uri}
                                    category={category}
                                    name={name}
                                    style={[
                                      styles.optionPhotoChoice,
                                      option.imageIndex === imgIdx && styles.optionPhotoChoiceActive,
                                    ]}
                                    contentFit="cover"
                                  />
                                </TouchableOpacity>
                              ))}
                            </View>
                          </View>
                        )}
                      </View>
                    );
                  })}

                  <TouchableOpacity style={styles.addOptionButton} onPress={() => addOption(gi)}>
                    <Ionicons name="add" size={16} color={colors.primary} />
                    <Text style={styles.addOptionText}>Add option</Text>
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={styles.addGroupButton} onPress={addGroup}>
                <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                <Text style={styles.addOptionText}>Add a variation group</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>Checkout Questions (optional)</Text>
            <Text style={styles.detailHint}>
              Extra info the buyer must fill in when ordering this item (e.g. Name,
              Campus branch, ID number). Phone number, delivery location, and payment
              proof are always asked — no need to add them here.
            </Text>
            {checkoutFields.map((field, fi) => (
              <View key={fi} style={styles.variantGroupCard}>
                <View style={styles.variantGroupHeader}>
                  <TextInput
                    style={[styles.input, styles.variantGroupName]}
                    value={field.label}
                    onChangeText={(text) => updateField(fi, { label: text })}
                    placeholder="Question (e.g. Name, ID number)"
                  />
                  <TouchableOpacity onPress={() => removeField(fi)} style={styles.variantDelete}>
                    <Ionicons name="trash-outline" size={20} color={colors.danger} />
                  </TouchableOpacity>
                </View>

                <View style={styles.fieldTypeRow}>
                  {(['text', 'dropdown'] as const).map((type) => (
                    <TouchableOpacity
                      key={type}
                      style={[
                        styles.fieldTypeChip,
                        field.type === type && styles.fieldTypeChipActive,
                      ]}
                      onPress={() => updateField(fi, { type })}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.fieldTypeText,
                          field.type === type && styles.fieldTypeTextActive,
                        ]}
                      >
                        {type === 'text' ? 'Text answer' : 'Dropdown'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={styles.variantPriceToggle}
                  onPress={() => updateField(fi, { required: !field.required })}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={field.required ? 'checkbox' : 'square-outline'}
                    size={20}
                    color={field.required ? colors.primary : colors.textSecondary}
                  />
                  <Text style={styles.variantToggleText}>Buyer must answer this</Text>
                </TouchableOpacity>

                {field.type === 'dropdown' && (
                  <>
                    {field.options.map((option, oi) => (
                      <View key={oi} style={styles.optionRow}>
                        <TextInput
                          style={[styles.input, styles.optionNameInput]}
                          value={option}
                          onChangeText={(text) => updateFieldOption(fi, oi, text)}
                          placeholder={`Choice ${oi + 1}`}
                        />
                        <TouchableOpacity
                          onPress={() => removeFieldOption(fi, oi)}
                          style={styles.variantDelete}
                        >
                          <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                        </TouchableOpacity>
                      </View>
                    ))}
                    <TouchableOpacity
                      style={styles.addOptionButton}
                      onPress={() => addFieldOption(fi)}
                    >
                      <Ionicons name="add" size={16} color={colors.primary} />
                      <Text style={styles.addOptionText}>Add choice</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            ))}
            <TouchableOpacity style={styles.addGroupButton} onPress={addField}>
              <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
              <Text style={styles.addOptionText}>Add a checkout question</Text>
            </TouchableOpacity>
          </View>

          {role === 'admin' && MERCHANT_ACCOUNT_EDITING_ENABLED && (
            <View style={styles.field}>
              <Text style={styles.label}>Shipping Fee (ETB)</Text>
              <Text style={styles.detailHint}>
                Flat delivery fee for your shop, charged once per order. Leave
                empty or 0 for free delivery. Also editable in Account &amp; Security.
              </Text>
              <TextInput
                style={styles.input}
                value={shippingFee}
                onChangeText={setShippingFee}
                placeholder="e.g. 100"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
              />
            </View>
          )}

          <Button
            title={existing ? 'Update Item' : 'Add Item'}
            onPress={handleSave}
            disabled={!isValid}
            style={styles.saveButton}
          />
        </View>
      </ScrollView>
    </Screen>
    </>
  );
}

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  container: {
    flex: 1,
    maxWidth: MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingBottom: spacing.xxl,
  },
  title: {
    fontSize: fontSizes.xxl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.lg,
  },
  titleCompact: {
    fontSize: fontSizes.xl,
  },
  field: {
    marginBottom: spacing.lg,
  },
  flex: {
    flex: 1,
  },
  label: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  coverPicker: {
    width: '100%',
    height: 280,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: colors.background,
    position: 'relative',
    ...(Platform.OS === 'web'
      ? ({
          height: 420,
        } as any)
      : {}),
  },
  coverPickerWithImage: {
    ...(Platform.OS === 'web'
      ? ({
          height: 520,
        } as any)
      : {
          height: 360,
        }),
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  imageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageOverlaySubtle: {
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  imageOverlayText: {
    color: colors.surface,
    fontSize: fontSizes.md,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  imageOverlayTextDark: {
    color: colors.text,
  },
  thumbnailList: {
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingVertical: spacing.xs,
  },
  thumbnailContainer: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    position: 'relative',
  },
  thumbnailContainerActive: {
    borderColor: colors.primary,
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  detailHint: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  detailAddTile: {
    justifyContent: 'center',
    alignItems: 'center',
    borderStyle: 'dashed',
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  descriptionInput: {
    minHeight: 100,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  coverBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.primary,
    paddingVertical: 2,
    alignItems: 'center',
  },
  coverBadgeText: {
    color: colors.surface,
    fontSize: fontSizes.xs,
    fontWeight: '700',
  },
  removeButton: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: colors.surface,
    borderRadius: 12,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSizes.md,
    color: colors.text,
    ...(Platform.OS === 'web'
      ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
      : {}),
  },
  row: {
    gap: spacing.md,
  },
  rowDesktop: {
    flexDirection: 'row',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  variantGroupCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  variantGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  variantGroupName: {
    flex: 1,
    paddingVertical: spacing.sm,
  },
  variantDelete: {
    padding: spacing.xs,
  },
  variantPriceToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  variantToggleText: {
    fontSize: fontSizes.sm,
    color: colors.text,
  },
  fieldTypeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  fieldTypeChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  fieldTypeChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  fieldTypeText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  fieldTypeTextActive: {
    color: colors.surface,
  },
  optionBlock: {
    marginBottom: spacing.sm,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  optionNameInput: {
    flex: 1,
    paddingVertical: spacing.sm,
  },
  optionPriceInput: {
    width: 110,
    paddingVertical: spacing.sm,
  },
  optionPhotoButton: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  optionPhotoThumb: {
    width: '100%',
    height: '100%',
  },
  optionPhotoStrip: {
    marginTop: spacing.sm,
  },
  optionPhotoChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  optionPhotoChoice: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.sm,
    borderWidth: 2,
    borderColor: colors.border,
  },
  optionPhotoChoiceActive: {
    borderColor: colors.primary,
  },
  addOptionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  addOptionText: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.primary,
  },
  addGroupButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
  },
  toggleText: {
    flex: 1,
    gap: 2,
  },
  toggleLabel: {
    fontSize: fontSizes.md,
    fontWeight: '600',
    color: colors.text,
  },
  toggleHint: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  dropdownField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  dropdownValue: {
    flex: 1,
    fontSize: fontSizes.md,
    color: colors.text,
  },
  dropdownValuePlaceholder: {
    color: colors.textSecondary,
  },
  dropdownList: {
    maxHeight: 220,
    marginTop: spacing.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
  },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dropdownOptionActive: {
    backgroundColor: colors.background,
  },
  dropdownOptionText: {
    flex: 1,
    fontSize: fontSizes.md,
    color: colors.text,
  },
  dropdownOptionTextActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  saveButton: {
    marginTop: spacing.md,
  },
});
