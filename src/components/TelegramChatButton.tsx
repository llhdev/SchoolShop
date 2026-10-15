import { StyleProp, TouchableOpacity, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { openTelegramChat } from '../lib/telegram';
import { useThemeColors } from '../constants/theme';

interface TelegramChatButtonProps {
  /** Shop's Telegram username; renders nothing when empty. */
  username?: string;
  size?: number;
  /** Extra styles (e.g. a bordered circle around the icon in a bottom bar). */
  style?: StyleProp<ViewStyle>;
}

/** Chat-with-shop icon: opens the DM with the given Telegram username.
 *  Used on the product detail page and per line item on the order detail page
 *  (migration 025). Hidden when the shop has no username set. */
export function TelegramChatButton({ username, size = 22, style }: TelegramChatButtonProps) {
  const colors = useThemeColors();
  const handle = username?.trim();
  if (!handle) return null;
  return (
    <TouchableOpacity
      style={style}
      onPress={() => openTelegramChat(handle)}
      accessibilityLabel="Chat with the shop on Telegram"
      accessibilityRole="button"
      hitSlop={8}
    >
      <Ionicons name="chatbubble-ellipses-outline" size={size} color={colors.primary} />
    </TouchableOpacity>
  );
}
