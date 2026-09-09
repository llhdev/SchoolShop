# Telegram Mini App runbook

The app ships as **one web build on two surfaces**: the standalone website and the Telegram Mini App load the same bundle from the same HTTPS URL. Native Android/iOS apps are unaffected — every TMA code path is gated behind `isTelegramMiniApp()` and no-ops elsewhere.

## Architecture

- `src/lib/telegram.ts` — lazy loader + typed wrapper for the official `telegram-web-app.js` SDK. Injects the script **only** when the Telegram WebView bridge (`window.TelegramWebviewProxy`) is present, so plain browsers never download it. Callers: `initTelegram()` (once, from `App.tsx`, before state hydration), `isTelegramMiniApp()`, `getTelegramUser()`, `getTelegramInitData()`, `configureTelegramMainButton()`, `onTelegramThemeChanged()`, `getTelegramBottomInset()`, `applyTelegramColors()`.
- `App.tsx` blocks first render until `initTelegram()` resolves (instant outside Telegram).
- `AppContext.tsx` — Telegram's color scheme overrides the stored theme; `themeChanged` events follow the user's Telegram theme; header/background colors are pushed to Telegram chrome. A validated `shopper` is cached under `@schoolshop_shopper` and drives server-side order history.
- `AppNavigator.tsx` — inside the Mini App the React Navigation header is hidden (it would overlap Telegram's BackButton) and Telegram's BackButton is driven from the navigation state. `linking` maps `product/:productId`, `cart`, `orders`, `checkout`, `order/:orderId` and strips the `/SchoolShop` base path.
- `CheckoutScreen.tsx` — the footer CTA is replaced by Telegram's native MainButton inside the Mini App.
- `Screen.tsx` — uses Telegram's `contentSafeAreaInset.bottom` for bottom padding inside the WebView (CSS `env(safe-area-inset-*)` is unreliable there).
- `src/lib/image-web.ts` — web/TMA admin image pipeline: hidden `<input type="file">` + canvas resize (800px full / 400px thumb). Native keeps `expo-image-picker` + `expo-image-manipulator`, both now **dynamically imported** so they stay out of the web bundle. Same for `expo-file-system` in `services/images.ts` and `utils/share.ts`.

## Database & identity

- Migration `011_telegram_shoppers.sql` — `shoppers` table + `orders.telegram_id` (applied).
- Edge Function `telegram-auth` (`supabase/functions/telegram-auth`, deployed) validates the HMAC-SHA256 signature of Telegram `initData` with the bot token and upserts the shopper. Config: `verify_jwt = false` in `supabase/config.toml` (initData is the credential).
- Secret: `TELEGRAM_BOT_TOKEN` must be set (Supabase Dashboard → Edge Functions → Secrets).
- **MVP caveat:** orders are inserted by the client with the validated `telegram_id`, but RLS still allows public inserts — a crafted client could forge another user's `telegram_id`. Orders are admin-reviewed before COD delivery, so the blast radius is low. Hardening option: route order inserts through an Edge Function that re-validates initData.

## Order notifications to the Telegram group

- Edge Function `telegram-order-notify` (`supabase/functions/telegram-order-notify`, deployed) posts every newly placed order to the shop's Telegram group: an HTML summary (phone, location, payment method, item lines, total, Telegram user when known) plus the cover image of each ordered item as a photo album (`sendMediaGroup`, capped at 10 photos; falls back to a plain `sendMessage` if there are no images or Telegram can't fetch them).
- The client calls it fire-and-forget from `AppContext.addOrder` after the insert succeeds (`src/services/telegramOrderNotify.ts`), gated by an anon-key bearer header (`verify_jwt = false` in `supabase/config.toml`). Order placement never depends on it.
- Secrets: `TELEGRAM_BOT_TOKEN` (shared with `telegram-auth`) and `TELEGRAM_ORDER_CHAT_ID` — the group chat id (negative number like `-1001234567890`). Get it by adding the bot to the group, sending any message, then opening `https://api.telegram.org/bot<TOKEN>/getUpdates` and reading `chat.id`. Without `TELEGRAM_ORDER_CHAT_ID` the function returns `{ notified: false }` and logs; nothing breaks.

## Deploy

- URL: `https://llhdev.github.io/SchoolShop` (GitHub Pages, `gh-pages` branch).
- `npm run build:web` → `expo export --platform web`; `scripts/prep-dist.js` adds `404.html` (SPA fallback) and `.nojekyll` (so the `_expo/` assets are served); `npm run deploy:web` publishes with `gh-pages`.
- `.github/workflows/deploy-web.yml` does the same on every push to `main`. Required repo secrets: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- `app.json` → `experiments.baseUrl` must match the hosting subpath (`/SchoolShop`). Root-hosted website builds should use `/`.
- To host the **website** elsewhere later: deploy the same `dist/` to that host; no code changes.

## Bot setup (one-time, requires your input)

1. Create the bot with @BotFather (`/newbot`) → get the token → set it as the `TELEGRAM_BOT_TOKEN` secret in Supabase.
2. Register the Mini App: `/newapp` → pick the bot → URL `https://llhdev.github.io/SchoolShop`.
3. Optionally set the bot's Menu Button (BotFather → Bot Settings → Menu Button) to the same URL so it opens from the chat menu.

## Testing checklist (physical Android device with Telegram)

- Open via the `t.me/<bot>/app` link (or the menu button).
- App expands fullscreen, header color matches theme; switching Telegram dark/light re-themes the app live.
- BackButton appears on pushed screens, navigates back, hides at root; the RN header is not visible.
- Cart persists after closing and reopening the Mini App.
- Checkout: MainButton shows "Place Order — X ETB", disables until the form is valid; placing an order lands on Orders; the order summary + item photos arrive in the Telegram group (once `TELEGRAM_ORDER_CHAT_ID` is set).
- Admin: type the admin username in the home search bar → login → Add Item → pick images → save → thumbnail + full image appear in the bucket; edit/delete work.
- Super admin: open an order → Mark as Completed / Mark as Failed → badge updates everywhere and survives reload; the Orders screen shows Pending/Completed/Failed counts and filter chips; a tenant admin sees no status buttons and gets RLS-denied if they try.
- Website (plain browser): same URL, WebHeader on wide screens, bottom tab bar on narrow, share uses the Web Share API.
