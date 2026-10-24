# Telegram Mini App runbook

The app ships as **one web build on two surfaces**: the standalone website and the Telegram Mini App load the same bundle from the same HTTPS URL. Native Android/iOS apps are unaffected — every TMA code path is gated behind `isTelegramMiniApp()` and no-ops elsewhere.

## Architecture

- `src/lib/telegram.ts` — lazy loader + typed wrapper for the official `telegram-web-app.js` SDK. Injects the script **only** when the Telegram WebView bridge (`window.TelegramWebviewProxy`) is present, so plain browsers never download it. Callers: `initTelegram()` (once, from `App.tsx`, before state hydration), `isTelegramMiniApp()`, `getTelegramUser()`, `getTelegramInitData()`, `configureTelegramMainButton()`, `onTelegramThemeChanged()`, `getTelegramBottomInset()`, `applyTelegramColors()`.
- `App.tsx` blocks first render until `initTelegram()` resolves (instant outside Telegram).
- `AppContext.tsx` — Telegram's color scheme overrides the stored theme; `themeChanged` events follow the user's Telegram theme; header/background colors are pushed to Telegram chrome. A validated `shopper` is cached under `@schoolshop_shopper` and drives server-side order history.
- `AppNavigator.tsx` — inside the Mini App the React Navigation header is hidden (it would overlap Telegram's BackButton) and Telegram's BackButton is driven from the navigation state. `linking` maps `product/:productId`, `orders`, `checkout`, `order/:orderId` anchored at the domain root (`WEB_BASE_PATH`).
- `CheckoutScreen.tsx` — the footer CTA is replaced by Telegram's native MainButton inside the Mini App.
- `Screen.tsx` — uses Telegram's `contentSafeAreaInset.bottom` for bottom padding inside the WebView (CSS `env(safe-area-inset-*)` is unreliable there).
- `src/lib/image-web.ts` — web/TMA admin image pipeline: hidden `<input type="file">` + canvas resize (800px full / 400px thumb). Native keeps `expo-image-picker` + `expo-image-manipulator`, both now **dynamically imported** so they stay out of the web bundle. Same for `expo-file-system` in `services/images.ts` and `utils/share.ts`.

## Database & identity

- Migration `011_telegram_shoppers.sql` — `shoppers` table + `orders.telegram_id` (applied).
- Edge Function `telegram-auth` (`supabase/functions/telegram-auth`, deployed) validates the HMAC-SHA256 signature of Telegram `initData` with the bot token and upserts the shopper. Config: `verify_jwt = false` in `supabase/config.toml` (initData is the credential).
- Secret: `TELEGRAM_BOT_TOKEN` must be set (Supabase Dashboard → Edge Functions → Secrets).
- **MVP caveat:** orders are inserted by the client with the validated `telegram_id`, but RLS still allows public inserts — a crafted client could forge another user's `telegram_id`. Orders are admin-reviewed before COD delivery, so the blast radius is low. Hardening option: route order inserts through an Edge Function that re-validates initData.

## Order notifications to Telegram groups (per tenant)

- Edge Function `telegram-order-notify` (`supabase/functions/telegram-order-notify`, deployed) routes a newly placed order to **each tenant's own Telegram group**: every shop that owns at least one ordered item gets an HTML summary prefixed with the shop name, containing **only that shop's line items** (order id, customer phone/location, Telegram user when known — shared, since it's one delivery — plus a per-shop subtotal) and the cover image of each of those items as a photo album (`sendMediaGroup`, capped at 10 photos; falls back to a plain `sendMessage` if there are no images or Telegram can't fetch them). It then includes **that shop's payment-proof photo as the last photo of the same album** (no separate message). There is no global notification group; tenants without a configured chat id are skipped and listed in the function's response. Migration `018_tenant_order_routing.sql` adds `profiles.telegram_chat_id` (set by the super admin in Tenant Management) and `orders.tenant_ids`, and a `stamp_order_tenants` trigger that stamps every order item with its product's `owner_id`/`shop_name` and fills `tenant_ids` on insert. The only payment method is direct bank transfer: checkout groups the bought item(s) by shop, shows each shop's account number/QR (from the owner's profile, exposed by the `fetch_products_with_shop` RPC after migration 021), requires one uploaded payment proof per shop, and verifies each shop's payment before the order is placed — Tesseract.js OCR (`src/lib/ocr.ts`, web/TMA-only, lazy-loaded) reads the CBE/Telebirr transaction reference off the receipt and the `verify-payment-reference` Edge Function checks it against verify.et's reference API (completion, recipient, exact amount, not previously claimed); the order is only placed once every shop verifies, and the post-order trigger replays the same idempotency key for the authoritative claim (migration 041). Line items carry their own statuses (`orders.item_statuses`, migration 022) so shoppers can track each item of a checkout independently.
- The client calls it fire-and-forget from `AppContext.addOrder` after the insert succeeds (`src/services/telegramOrderNotify.ts`), gated by an anon/publishable-key bearer header (`verify_jwt = false` in `supabase/config.toml`). Order placement never depends on it — but failures are logged: the function returns per-shop `notified`/`skipped` (with Telegram's error message in the skip reason), and the client `console.warn`s on non-200 responses and on any skipped shop, so check the browser devtools console first when a notification goes missing.
- Secrets: `TELEGRAM_BOT_TOKEN` (shared with `telegram-auth`) and `PUBLISHABLE_KEY` (the project's `sb_publishable_…` API key — accepted by the function's auth gate alongside the legacy anon JWT that Supabase injects as `SUPABASE_ANON_KEY`, so both old and new client builds pass).
- **Supergroup auto-heal:** when a tenant's Telegram group is upgraded to a supergroup, Telegram assigns it a **new chat id** and rejects sends to the old one with `migrate_to_chat_id`. The function detects this, updates `profiles.telegram_chat_id` itself, and retries once — group upgrades no longer break notifications (this exact scenario caused the Oct 2026 outage).
- The per-tenant chat ids live in the database, **not** in secrets: the super admin enters each tenant's group chat id (negative number like `-1001234567890`) in Tenant Management (create or edit a tenant). Get a group's chat id by adding the bot to the group, sending any message, then opening `https://api.telegram.org/bot<TOKEN>/getUpdates` and reading `chat.id`.
- Tenant order visibility matches the routing: tenant admins only see orders whose `tenant_ids` include them (and within a mixed order, only their shop's line items, with totals recalculated); the super admin sees everything. Orders SELECT is still public (needed for shopper history), so this filtering is query/client-side — same MVP caveat as above.

## Deploy

- URL: `https://timor-shop.vercel.app` (Vercel, served from the domain root; project `tryout1/timor-shop`).
- `vercel.json` runs `npx expo export --platform web` (`npm ci`, output `dist/`) and rewrites all paths to `index.html` (SPA fallback). Deploy with `vercel deploy --prod`; `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are set as Vercel project env vars (inlined at build time).
- Legacy GitHub Pages pipeline (still wired up): `npm run build:web` → `expo export --platform web`; `scripts/prep-dist.js` adds `404.html` (SPA fallback) and `.nojekyll`; `npm run deploy:web` publishes with `gh-pages`; `.github/workflows/deploy-web.yml` does the same on every push to `main` (requires the `EXPO_PUBLIC_*` repository secrets).

## Bot setup (one-time, requires your input)

1. Create the bot with @BotFather (`/newbot`) → get the token → set it as the `TELEGRAM_BOT_TOKEN` secret in Supabase.
2. Register the Mini App: `/newapp` → pick the bot → URL `https://timor-shop.vercel.app` (already-registered apps: `/myapps` → Edit URL — this must be updated from the old `https://llhdev.github.io/SchoolShop` GitHub Pages URL to serve the Mini App from Vercel).
3. Optionally set the bot's Menu Button (BotFather → Bot Settings → Menu Button) to the same URL so it opens from the chat menu.

## Testing checklist (physical Android device with Telegram)

- Open via the `t.me/<bot>/app` link (or the menu button).
- App expands fullscreen, header color matches theme; switching Telegram dark/light re-themes the app live.
- BackButton appears on pushed screens, navigates back, hides at root; the RN header is not visible.
- There is no cart: the product page has a quantity stepper and Buy, which goes straight to checkout.
- Checkout: MainButton shows "Place Order — X ETB", disables until the form is valid; placing an order lands on Orders; each shop's summary + its item photos arrive in that shop's Telegram group (once the super admin has set the tenant's chat id).
- Admin: type the admin username in the home search bar → login → Add Item → pick images → save → thumbnail + full image appear in the bucket; edit/delete work.
- Super admin: open an order → Mark as Completed / Mark as Failed → badge updates everywhere and survives reload; the Orders screen shows Pending/Completed/Failed counts and filter chips; a tenant admin sees no status buttons and gets RLS-denied if they try.
- Tenant admin: the Orders screen lists only orders containing their shop's products; a mixed order shows only their line items (with an "N of M items" note) and per-shop totals; the matching order message lands only in their Telegram group.
- Website (plain browser): same URL, WebHeader on wide screens, bottom tab bar on narrow, share uses the Web Share API.

## Troubleshooting: order notifications stopped arriving

Notifications are fire-and-forget by design, so the app keeps working when they break. Diagnose in this order:

1. **Replay a recent order and read the response.** The function returns per-shop `notified` / `skipped` with the exact reason (including Telegram's error message):
   ```bash
   curl -X POST "$SUPABASE_URL/functions/v1/telegram-order-notify" \
     -H "Authorization: Bearer <anon-or-publishable-key>" \
     -H "Content-Type: application/json" \
     -d '{"id":"<ORDER_ID>","items":[<items copied from the orders row>]}'
   ```
   (Orders are anon-readable; fetch the row from `/rest/v1/orders?id=eq.<ORDER_ID>` first. Replaying re-sends the message to the tenant's group.)
2. **`skipped: "no chat id configured"`** — set the tenant's chat id in Tenant Management.
3. **`sendMessage 400: ... group chat was upgraded to a supergroup`** — handled automatically since Oct 2026 (the function adopts `migrate_to_chat_id` and updates the profile). On older deployments, update the chat id manually.
4. **`sendMessage 403: bot was kicked / not a member`** — re-add the bot to the group.
5. **HTTP 401 from the function** — the client's API key isn't recognized. The gate accepts the legacy anon JWT and the `PUBLISHABLE_KEY` secret; if you rotated keys, update the secret: `supabase secrets set PUBLISHABLE_KEY=sb_publishable_…`.
6. **Function logs:** Supabase Dashboard → Edge Functions → `telegram-order-notify` → Logs.
7. **Bot token:** `https://api.telegram.org/bot<TOKEN>/getMe` should return the bot; if not, regenerate in @BotFather and update the `TELEGRAM_BOT_TOKEN` secret.
