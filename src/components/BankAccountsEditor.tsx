import { useState } from 'react';
import { Alert, Image, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BankAccount } from '../types';
import { uploadBankQr } from '../services/images';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

interface BankAccountsEditorProps {
  value: BankAccount[];
  onChange: (accounts: BankAccount[]) => void;
}

/** Editable list of a shop's bank transfer accounts (number + optional bank
 *  name + optional QR each). QR codes upload as-is — they must stay
 *  scannable. Shared by the tenant account screen and the super admin's
 *  tenant create/edit forms. */
export function BankAccountsEditor({ value, onChange }: BankAccountsEditorProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);

  function update(index: number, patch: Partial<BankAccount>) {
    onChange(value.map((account, i) => (i === index ? { ...account, ...patch } : account)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { accountNumber: '' }]);
  }

  /** Upload a QR code for one account row. Web picks via a hidden file input;
   *  native uses expo-image-picker (dynamic import keeps it out of the web
   *  bundle). Uploaded as-is so the code stays scannable. */
  async function pickQr(index: number) {
    let localUri: string | null = null;
    if (Platform.OS === 'web') {
      const { pickImagesWeb } = await import('../lib/image-web');
      const uris = await pickImagesWeb();
      localUri = uris[0] ?? null;
    } else {
      const ImagePicker = await import('expo-image-picker');
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.9,
      });
      localUri = !result.canceled ? (result.assets[0]?.uri ?? null) : null;
    }
    if (!localUri) return;

    setUploadingIndex(index);
    try {
      const url = await uploadBankQr(localUri);
      update(index, { qrImageUrl: url });
    } catch {
      Alert.alert('Upload Failed', 'Could not upload the QR code. Please try again.');
    } finally {
      setUploadingIndex(null);
    }
  }

  return (
    <View style={styles.container}>
      {value.map((account, index) => {
        const uploading = uploadingIndex === index;
        return (
          <View key={index} style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowTitle}>Account {index + 1}</Text>
              <TouchableOpacity onPress={() => remove(index)} disabled={uploading}>
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={account.bankName ?? ''}
              onChangeText={(text) => update(index, { bankName: text })}
              placeholder="Bank name (optional, e.g. CBE)"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="words"
              autoCorrect={false}
            />
            <TextInput
              style={styles.input}
              value={account.accountNumber}
              onChangeText={(text) => update(index, { accountNumber: text })}
              placeholder="Bank account number"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
            {account.qrImageUrl ? (
              <View style={styles.qrPreviewRow}>
                <Image
                  source={{ uri: account.qrImageUrl }}
                  style={styles.qrPreview}
                  resizeMode="contain"
                />
                <TouchableOpacity onPress={() => update(index, { qrImageUrl: undefined })}>
                  <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.qrPickButton, uploading && styles.qrPickButtonDisabled]}
                onPress={() => pickQr(index).catch(() => {})}
                disabled={uploading}
              >
                <Ionicons
                  name={uploading ? 'hourglass-outline' : 'qr-code-outline'}
                  size={16}
                  color={colors.primary}
                />
                <Text style={styles.qrPickButtonText}>
                  {uploading ? 'Uploading QR…' : 'Upload QR code (optional)'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
      <TouchableOpacity style={styles.addButton} onPress={add}>
        <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
        <Text style={styles.addButtonText}>Add another account</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    container: {
      gap: spacing.sm,
    },
    row: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      padding: spacing.sm,
      gap: spacing.sm,
      backgroundColor: colors.background,
    },
    rowHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    rowTitle: {
      fontSize: fontSizes.sm,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    input: {
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
    qrPreviewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    qrPreview: {
      width: 96,
      height: 96,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    qrPickButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.primary,
      borderRadius: borderRadius.sm,
      paddingVertical: spacing.md,
      backgroundColor: colors.surface,
    },
    qrPickButtonDisabled: {
      opacity: 0.6,
    },
    qrPickButtonText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
    },
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
    },
    addButtonText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
    },
  });
