import { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './Button';
import {
  fetchStaff,
  createStaffAccount,
  updateStaffAccount,
  setStaffPassword,
  deleteStaffAccount,
  StaffAccount,
} from '../services/tenants';
import { confirmAction } from '../utils/confirm';
import { notify } from '../utils/notify';
import { StaffCapabilities } from '../types';
import { useThemeColors, spacing, borderRadius, fontSizes, ColorPalette } from '../constants/theme';

/** Staff capability toggles with their one-line descriptions (migration 045). */
const STAFF_CAPABILITIES: {
  key: keyof StaffCapabilities;
  title: string;
  description: string;
}[] = [
  {
    key: 'financial',
    title: 'Financial Admin',
    description: 'Verifies payments and marks orders paid.',
  },
  {
    key: 'shop',
    title: 'Shop Admin',
    description: "Manages the shop's products and catalog.",
  },
  {
    key: 'branch',
    title: 'Branch Admin',
    description: 'Receives, ships, completes, and cancels orders for one branch.',
  },
];

/** Staff accounts card + create/edit/password modal (migration 045). Shared by
 *  the super admin (Tenant Detail) and the shop owner (Account screen, 048).
 *  Since migration 046 a Branch Admin account IS a branch — the label is the
 *  branch name and the service keeps the branch row in sync. */
export function StaffManager({
  tenant,
}: {
  tenant: { id: string; username: string | null };
}) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);

  const [staff, setStaff] = useState<StaffAccount[]>([]);
  const [staffModal, setStaffModal] = useState<{
    mode: 'create' | 'edit' | 'password';
    staff?: StaffAccount;
  } | null>(null);
  const [staffLabel, setStaffLabel] = useState('');
  const [staffPasswordInput, setStaffPasswordInput] = useState('');
  const [staffCaps, setStaffCaps] = useState<StaffCapabilities>({
    financial: false,
    shop: false,
    branch: false,
  });
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  /** Inline success feedback on the card (Alert.alert is a no-op on web). */
  const [staffSuccess, setStaffSuccess] = useState<string | null>(null);

  const loadStaff = useCallback(async () => {
    try {
      setStaff(await fetchStaff(tenant.id));
    } catch (error) {
      console.error('Failed to load staff:', error);
    }
  }, [tenant.id]);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  function openCreateStaff() {
    setStaffLabel('');
    setStaffPasswordInput('');
    setStaffCaps({ financial: false, shop: false, branch: false });
    setStaffError(null);
    setStaffSuccess(null);
    setStaffModal({ mode: 'create' });
  }

  function openEditStaff(account: StaffAccount) {
    setStaffLabel(account.label ?? '');
    setStaffPasswordInput('');
    setStaffCaps(account.capabilities);
    setStaffError(null);
    setStaffSuccess(null);
    setStaffModal({ mode: 'edit', staff: account });
  }

  function openPasswordStaff(account: StaffAccount) {
    setStaffPasswordInput('');
    setStaffError(null);
    setStaffSuccess(null);
    setStaffModal({ mode: 'password', staff: account });
  }

  async function handleStaffSubmit() {
    if (!staffModal) return;
    const { mode, staff: target } = staffModal;
    if (mode !== 'password') {
      if (!staffCaps.financial && !staffCaps.shop && !staffCaps.branch) {
        setStaffError('Turn on at least one capability.');
        return;
      }
      // A Branch Admin's label is the branch name shoppers see at checkout.
      if (staffCaps.branch && !staffLabel.trim()) {
        setStaffError('A Branch Admin needs a label — it becomes the branch name.');
        return;
      }
    }
    if (mode !== 'edit' && staffPasswordInput.length < 6) {
      setStaffError('Password must be at least 6 characters.');
      return;
    }
    setStaffSaving(true);
    setStaffError(null);
    try {
      if (mode === 'create') {
        await createStaffAccount(tenant, {
          label: staffLabel,
          password: staffPasswordInput,
          capabilities: staffCaps,
        });
      } else if (mode === 'edit' && target) {
        await updateStaffAccount(target, {
          label: staffLabel,
          capabilities: staffCaps,
        });
      } else if (mode === 'password' && target) {
        await setStaffPassword(target.id, staffPasswordInput);
      }
      setStaffModal(null);
      await loadStaff();
      setStaffSuccess(
        mode === 'password'
          ? 'Password updated.'
          : mode === 'create'
            ? 'Staff account created. Staff log in with the shop username and this password.'
            : 'Staff account updated.'
      );
    } catch (error) {
      setStaffError(error instanceof Error ? error.message : 'Failed to save staff account.');
    } finally {
      setStaffSaving(false);
    }
  }

  function handleRemoveStaff(account: StaffAccount) {
    confirmAction(
      'Remove staff account?',
      `"${account.label ?? account.email ?? account.id}" will no longer be able to log in. Products and orders are not affected.`,
      'Remove',
      async () => {
        try {
          await deleteStaffAccount(account);
          await loadStaff();
          setStaffSuccess('Staff account removed.');
        } catch (error) {
          notify(
            error instanceof Error ? error.message : 'Failed to remove staff account.',
            'error'
          );
        }
      }
    );
  }

  return (
    <>
      <View style={styles.card}>
        <View style={styles.sectionBody}>
          <Text style={styles.sectionTitle}>Staff Accounts</Text>
          <Text style={styles.sectionHint}>
            Staff log in with the shop username (@{tenant.username ?? 'unknown'}) and their own
            password — the password picks the account. A Branch Admin's label is the branch
            shoppers pick at checkout.
          </Text>
          {staffSuccess && <Text style={styles.successText}>{staffSuccess}</Text>}
          {staff.map((account) => {
            return (
              <View key={account.id} style={styles.staffRow}>
                <View style={styles.staffInfo}>
                  <Text style={styles.staffName} numberOfLines={1}>
                    {account.label || account.email || 'Staff'}
                  </Text>
                  {account.label && account.email ? (
                    <Text style={styles.staffEmail} numberOfLines={1}>
                      {account.email}
                    </Text>
                  ) : null}
                  <View style={styles.badgeRow}>
                    {account.capabilities.financial && (
                      <Text style={styles.badge}>Financial</Text>
                    )}
                    {account.capabilities.shop && <Text style={styles.badge}>Shop</Text>}
                    {account.capabilities.branch && (
                      <Text style={styles.badge}>Branch</Text>
                    )}
                  </View>
                </View>
                <View style={styles.staffActions}>
                  <TouchableOpacity
                    style={styles.staffActionButton}
                    onPress={() => openEditStaff(account)}
                  >
                    <Ionicons name="create-outline" size={18} color={colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.staffActionButton}
                    onPress={() => openPasswordStaff(account)}
                  >
                    <Ionicons name="key-outline" size={18} color={colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.staffActionButton}
                    onPress={() => handleRemoveStaff(account)}
                  >
                    <Ionicons name="trash-outline" size={18} color={colors.danger} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
          {staff.length === 0 && (
            <Text style={styles.sectionHint}>No staff accounts yet.</Text>
          )}
          <Button
            title="Add Staff"
            onPress={openCreateStaff}
            variant="outline"
            style={styles.sectionSaveButton}
          />
        </View>
      </View>

      <Modal
        visible={staffModal !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setStaffModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <ScrollView
              style={styles.modalScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
            <Text style={styles.editTitle}>
              {staffModal?.mode === 'create'
                ? 'Add Staff Account'
                : staffModal?.mode === 'edit'
                  ? 'Edit Staff Account'
                  : 'Reset Password'}
            </Text>
            {staffModal?.mode !== 'password' && (
              <>
                <Text style={styles.editLabel}>
                  {staffCaps.branch ? 'Label (required — branch name)' : 'Label (optional)'}
                </Text>
                <TextInput
                  style={styles.editInput}
                  value={staffLabel}
                  onChangeText={setStaffLabel}
                  placeholder="e.g. Accountant, Bole branch manager"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="words"
                />
                {staffCaps.branch && (
                  <Text style={styles.sectionHint}>
                    This label becomes the branch name shoppers pick at checkout.
                  </Text>
                )}
                {STAFF_CAPABILITIES.map((capability) => (
                  <View key={capability.key} style={styles.capabilityRow}>
                    <View style={styles.capabilityText}>
                      <Text style={styles.capabilityTitle}>{capability.title}</Text>
                      <Text style={styles.capabilityDescription}>
                        {capability.description}
                      </Text>
                    </View>
                    <Switch
                      value={staffCaps[capability.key]}
                      onValueChange={(value) =>
                        setStaffCaps((prev) => ({ ...prev, [capability.key]: value }))
                      }
                      trackColor={{ false: colors.border, true: colors.primary }}
                    />
                  </View>
                ))}
              </>
            )}
            {staffModal?.mode !== 'edit' && (
              <>
                <Text style={styles.editLabel}>
                  {staffModal?.mode === 'password' ? 'New password' : 'Password'}
                </Text>
                <TextInput
                  style={styles.editInput}
                  value={staffPasswordInput}
                  onChangeText={setStaffPasswordInput}
                  placeholder="Min 6 characters"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </>
            )}
            {staffError && (
              <Text style={[styles.editMessage, styles.editError]}>{staffError}</Text>
            )}
            <View style={styles.editActions}>
              <Button
                title={staffModal?.mode === 'password' ? 'Set Password' : 'Save'}
                onPress={handleStaffSubmit}
                loading={staffSaving}
                disabled={staffSaving}
              />
              <Button
                title="Cancel"
                onPress={() => setStaffModal(null)}
                variant="outline"
                disabled={staffSaving}
              />
            </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: spacing.lg,
    },
    sectionBody: {
      padding: spacing.md,
      gap: spacing.sm,
    },
    sectionTitle: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
    },
    sectionHint: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    sectionSaveButton: {
      marginTop: spacing.sm,
    },
    staffRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.background,
      padding: spacing.sm,
      gap: spacing.sm,
    },
    staffInfo: {
      flex: 1,
      gap: spacing.xs,
    },
    staffName: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
    },
    staffEmail: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
    },
    badgeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    badge: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.primary,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.primary,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      overflow: 'hidden',
    },
    staffActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    staffActionButton: {
      width: 36,
      height: 36,
      borderRadius: borderRadius.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.lg,
    },
    modalCard: {
      width: '100%',
      maxWidth: 480,
      maxHeight: '90%',
      backgroundColor: colors.surface,
      borderRadius: borderRadius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
    },
    modalScroll: {
      flexGrow: 0,
    },
    capabilityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    capabilityText: {
      flex: 1,
    },
    capabilityTitle: {
      fontSize: fontSizes.md,
      fontWeight: '600',
      color: colors.text,
    },
    capabilityDescription: {
      fontSize: fontSizes.sm,
      color: colors.textSecondary,
      marginTop: 2,
    },
    editTitle: {
      fontSize: fontSizes.lg,
      fontWeight: '700',
      color: colors.text,
      marginBottom: spacing.xs,
    },
    editLabel: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.textSecondary,
      marginBottom: spacing.xs,
    },
    editInput: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSizes.md,
      color: colors.text,
      marginBottom: spacing.sm,
      ...(Platform.OS === 'web'
        ? ({ outlineStyle: 'none', boxShadow: 'none' } as any)
        : {}),
    },
    editMessage: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      marginBottom: spacing.sm,
    },
    editError: {
      color: colors.danger,
    },
    successText: {
      fontSize: fontSizes.sm,
      fontWeight: '600',
      color: colors.success,
    },
    editActions: {
      gap: spacing.md,
    },
  });
