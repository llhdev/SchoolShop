import { StyleSheet, Text, View } from 'react-native';
import { Shopper } from '../types';
import { borderRadius, fontSizes, spacing, useThemeColors, ColorPalette } from '../constants/theme';

interface Props {
  shopper: Shopper;
}

/**
 * Shows the Telegram account the Mini App is linked to. Renders nothing for
 * null shoppers (callers gate) — the badge makes the silent account linking
 * visible and tells shoppers their order history is saved on their account.
 */
export function TelegramAccountBadge({ shopper }: Props) {
  const colors = useThemeColors();
  const styles = makeStyles(colors);
  const displayName = [shopper.firstName, shopper.lastName].filter(Boolean).join(' ');

  return (
    <View style={styles.row}>
      <View style={styles.avatar}>
        <Text style={styles.avatarInitial}>
          {(shopper.firstName || '?').charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.texts}>
        <Text style={styles.caption}>Signed in with Telegram</Text>
        <Text style={styles.name} numberOfLines={1}>
          {displayName}
          {shopper.username ? <Text style={styles.username}> @{shopper.username}</Text> : null}
        </Text>
      </View>
    </View>
  );
}

const AVATAR_SIZE = 32;

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarInitial: {
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.surface,
  },
  texts: {
    flex: 1,
  },
  caption: {
    fontSize: fontSizes.xs,
    color: colors.textSecondary,
  },
  name: {
    fontSize: fontSizes.sm,
    fontWeight: '600',
    color: colors.text,
  },
  username: {
    fontWeight: '400',
    color: colors.textSecondary,
  },
});
