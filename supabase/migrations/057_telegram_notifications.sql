-- 057: orders.telegram_notifications — per-tenant Telegram message locator.
--
-- telegram-order-notify sends ONE message per order per shop group. The
-- payment-verification state rides inline in that message's caption (warning
-- line at send time; see 056), and when a verification completes after the
-- message was sent (slow verify.et completing via the webhook, or a warning
-- pass auto-upgrading to verified), verifyWorkflow edits the SAME message in
-- place — never a second message. To edit, the bot needs the caption-bearing
-- message id, stored here at send time (with the exact caption text, since
-- the Bot API cannot read a caption back):
-- tenant owner id -> { chat_id, message_id, kind: 'photo'|'album'|'document'|'text', text }

ALTER TABLE public.orders
  ADD COLUMN telegram_notifications jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.orders.telegram_notifications IS
  'tenant id -> {chat_id, message_id, kind, text} of the caption-bearing Telegram order message, for in-place verification edits';
