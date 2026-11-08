import { Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

/** One branch row in the editor. Rows without an id are new (inserted on
 *  save); setTenantBranches replaces the whole list (migration 045). */
export interface EditableBranch {
  id?: string;
  name: string;
  deliveryLocation?: string;
  phone?: string;
}

interface BranchesEditorProps {
  value: EditableBranch[];
  onChange: (branches: EditableBranch[]) => void;
}

/** Editable list of a shop's branches (name + optional delivery location +
 *  optional phone each). Shared by the tenant create form and the tenant
 *  detail screen. */
export function BranchesEditor({ value, onChange }: BranchesEditorProps) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  function update(index: number, patch: Partial<EditableBranch>) {
    onChange(value.map((branch, i) => (i === index ? { ...branch, ...patch } : branch)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { name: '' }]);
  }

  return (
    <View style={styles.container}>
      {value.map((branch, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={styles.rowTitle}>Branch {index + 1}</Text>
            <TouchableOpacity onPress={() => remove(index)}>
              <Ionicons name="trash-outline" size={18} color={colors.danger} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            value={branch.name}
            onChangeText={(text) => update(index, { name: text })}
            placeholder="Branch name (required, e.g. Main Campus)"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="words"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={branch.deliveryLocation ?? ''}
            onChangeText={(text) => update(index, { deliveryLocation: text })}
            placeholder="Delivery location (optional)"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="sentences"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={branch.phone ?? ''}
            onChangeText={(text) => update(index, { phone: text })}
            placeholder="Phone (optional)"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="phone-pad"
          />
        </View>
      ))}
      <TouchableOpacity style={styles.addButton} onPress={add}>
        <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
        <Text style={styles.addButtonText}>Add branch</Text>
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
