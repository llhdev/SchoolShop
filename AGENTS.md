# Timor Shop — Agent Guide

Agent guide for the **Timor Shop** project: stack, architecture, conventions, and how to build and run. Prefer the actual source code over this document when they disagree.

---

## Project overview

**Timor Shop** is a cross-platform mobile app built with **Expo SDK 54** and **React Native**. It is a student shopping MVP: users browse school supplies, add items to a cart, check out, and view order history. An admin mode manages products, categories, and orders.

The admin layer is tenant-based: a single **super admin** manages categories and tenant admins; each **tenant admin** only uploads products and picks from existing categories. Admins log in by typing their **username** into the home-screen search bar. Default super admin username: `santa2024`.

Key facts:

- **Supabase** is the source of truth; AsyncStorage is a local cache for instant UI rendering.
- Reads are cache-first; writes are optimistic (update UI, then sync). Realtime subscriptions keep clients in sync.
- No real authentication or payment gateway in this phase: RLS allows public read/write; shoppers pay tenants by direct bank transfer and upload a proof photo.
- Supports **iOS**, **Android**, and **web** through Expo.
- One web build serves **two surfaces**: the standalone website and a **Telegram Mini App**. TMA-specific code is gated behind `isTelegramMiniApp()` and no-ops elsewhere. See `docs/telegram-mini-app.md`.
- Web has dedicated headers (`WebHeader`, `AdminHeader`); the bottom tab bar is the navigation chrome on native and narrow web/TMA viewports.

---

## Technology stack

| Layer | Technology | Version / Notes |
|-------|------------|-----------------|
| Framework | Expo SDK | `~54.0.36` (managed workflow) |
| UI library | React Native | `0.81.5` |
| Web runtime | react-native-web | `^0.21.0` |
| React | react / react-dom | `19.1.0` |
| Language | TypeScript | `~5.9.2`, strict mode |
| Navigation | React Navigation v7 | native-stack + bottom-tabs |
| State | React Context + `useReducer` | `src/context/AppContext.tsx` |
| Backend / DB | Supabase | `@supabase/supabase-js` — Postgres + Realtime |
| Local cache | AsyncStorage | `2.2.0` |
| File storage | Cloudflare R2 | `timor-shop-images` bucket (public, `img.timor.et`) + `timor-shop-proofs` bucket (private, presigned access only) |
| Styling | RN `StyleSheet` | tokens in `src/constants/theme.ts` |
| Icons | `@expo/vector-icons` | Ionicons |
| Images | `expo-image-picker`, `expo-image-manipulator` | admin product uploads |
| Picker | `@react-native-picker/picker` | category selector |

Docs: <https://docs.expo.dev/versions/v54.0.0/>

---

## Project structure

```
.
├── App.tsx / index.ts               # root (AppProvider + AppNavigator) / Expo registration
├── app.json / package.json / tsconfig.json
├── assets/                          # icons, splash, favicon
├── supabase/
│   ├── functions/
│   │   ├── telegram-auth/           # validates Telegram initData, upserts shoppers
│   │   ├── telegram-order-notify/   # sends each order to every shop's Telegram group
│   │   ├── verify-order-payment/    # DB-triggered verify.et check of payment proofs
│   │   ├── verify-payment-reference/ # pre-order read-only reference check (checkout calls it)
│   │   ├── r2-upload-sign/          # presigned R2 access: admin PUT/delete (images), anon proof PUT, admin proof GET
│   │   └── verify-et-webhook/       # completes queued verifications (signed, idempotent)
│   └── migrations/                  # 001–043, in order; header comments document each
├── docs/telegram-mini-app.md        # TMA runbook
├── .github/workflows/deploy-web.yml # CI: web export -> gh-pages on push to main
├── scripts/                         # prep-dist.js, setup-admin.js, reset-data.js,
│                                    # clean-database.js, test-reference-verification.js
└── src/
    ├── components/                  # AdminHeader, BankAccountsEditor, Button, CartItemRow,
    │                                # CategoryFilter, EmptyState, ProductCard, ProductImage,
    │                                # ImageViewerModal, Screen, SearchBar, StoreList,
    │                                # VerificationBadge, WebHeader
    ├── constants/                   # categories.ts, landmarks.ts, theme.ts
    ├── context/AppContext.tsx       # global state, reducer, actions, persistence
    ├── data/seedProducts.ts
    ├── hooks/useResponsive.ts
    ├── lib/                         # debounce, image-web, ocr (Tesseract.js receipts),
    │                                # supabase client, telegram SDK wrapper
    ├── navigation/                  # AppNavigator (root, role routing, lazy splitting),
    │                                # AdminStackNavigator, UserTabNavigator
    ├── screens/
    │   ├── admin/                   # AdminDashboard, AdminOrders, AdminAnalysis,
    │   │                            # AdminUserOrders, AddEditItem, TenantManagement
    │   └── user/                    # Home, ProductDetail, Cart, Checkout, Orders, OrderDetail
    ├── services/                    # cache, categories, images, orders, products, tenants,
    │                                # paymentVerifications (040), paymentVerificationCheckout (041),
    │                                # settings (042), telegramAuth, telegramOrderNotify
    ├── types/                       # index.ts (domain), navigation.ts (param lists)
    └── utils/                       # format, images, storage, validation, variants, checkoutFields
```

---

## Build and run commands

Requirements: Node.js `22+`, npm `10+`, Expo Go on a physical device or an emulator.

```bash
npm install
npm start

npm run android   # Android emulator or connected device
npm run ios       # iOS simulator (macOS only)
npm run web       # Web browser

npm run build:web   # static web export to dist/ (website + Telegram Mini App share it)
```

The production deploy target is **Vercel**: `vercel.json` builds with `expo export --platform web`, serves `dist/`, and rewrites all paths to `index.html`. Deploy with `vercel deploy --prod`; `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` must be set on the Vercel project (inlined at build time).

The legacy GitHub Pages pipeline still exists: `npm run deploy:web` publishes `dist/` to `gh-pages`, and `.github/workflows/deploy-web.yml` does the same on push to `main`.

---

## Architecture notes

### State management

All shared state lives in `src/context/AppContext.tsx`:

- A single `useReducer` manages `role`, `products`, `cart`, `orders`, `categories`.
- On mount the app loads the AsyncStorage cache so the UI renders offline, then a background sync fetches from Supabase.
- Mutations are optimistic: reducer → cache → Supabase; failures roll back.
- Realtime subscriptions refresh state + cache on product/order/category changes (refetches debounced).
- Orders are admin-only: shoppers never fetch the global order list — their history is orders placed on that device (cached locally). Super admin fetches all; tenant admins fetch orders whose `tenant_ids` include them (018) and see only their line items in mixed orders. Sign-out clears orders from memory and cache.
- Shopper Analysis (`AdminAnalysisScreen`): tenant-scoped orders, one row per line item (order code, date, phone, Telegram name from the public-read `shoppers` table, student name, product, qty, status, one column per checkout-question label — case/separator variants merged — location last). Revenue card is super-admin-only. Rows open `OrderDetail`; web exports `.xlsx` (`src/utils/exportAnalysis.ts`, SheetJS lazy).
- In the Mini App, a validated `shopper` (from `telegram-auth`, cached at `@schoolshop_shopper`) gives server-side order history by `telegram_id` across devices. Skipped while an admin is signed in.
- The Supabase client persists auth sessions via AsyncStorage, so admin sign-in survives restarts.
- Derived values (`cartTotal`, `cartCount`) are computed at render time.

Actions: `SET_ROLE`, `SET_PRODUCTS`, `ADD_PRODUCT`, `UPDATE_PRODUCT`, `DELETE_PRODUCT`, `ADD_TO_CART`, `SET_CART`, `REMOVE_FROM_CART`, `UPDATE_CART_QUANTITY`, `CLEAR_CART`, `SET_ORDERS`, `ADD_ORDER`, `UPDATE_ORDER`, `DELETE_ORDER`, `SET_CATEGORIES`, `ADD_CATEGORY`, `REMOVE_CATEGORY`.

### Navigation

`AppNavigator.tsx` switches the root navigator on `role`:

- `user` → `UserTabs` + `ProductDetail`, `Checkout`, `OrderDetail`, hidden `AdminLogin`
- `admin` / `super_admin` → `AdminStack` + shared `ProductDetail`, `OrderDetail`

The app starts as a shopper. Typing an admin **username** into the home search bar resolves it via `get_admin_by_username` and opens the login screen pre-filled with the admin's email.

Tenant admins are created in-app from **Tenant Management**: super admin enters username, password, shop name; the app derives `<username>@tenant.schoolshop.app` and calls `supabase.auth.signUp()` with a secondary in-memory client so the super admin's session survives. The `on_auth_user_created` trigger creates the profile with `role='admin'`. Deletion uses `delete_tenant_user`; migration 026 also deletes the tenant's products.

Within the admin stack:
- `super_admin`: categories, tenants, all products — never posts items (Add Item hidden/blocked). Orders screen lists tenants; tapping a shop shows its orders grouped by customer phone, scoped to its line items.
- `admin` (tenant): only own products; picks from existing categories.

Param lists in `src/types/navigation.ts`. Web has a `linking` config (`product/:productId`, `cart`, `orders`, `checkout`, `order/:orderId`) anchored at the domain root (`WEB_BASE_PATH`). In the Mini App the RN header is hidden (would overlap Telegram's BackButton), driven from navigation state.

### Data model

- `Product`: `id`, `name`, `description`, `price`, `compareAtPrice` (optional "original" price for discount display), `category`, `images` (string array), `detailImages` (extra photos under description, 027), `priceHidden` ("price on request", 029 — no price/cart; ordered via the shop's Telegram chat, price 0), `orderCount` (server-maintained, 030 — Popular sort), `coverImageIndex`, `createdAt`, `ownerId`, `shopName` (via `fetch_products_with_shop`), `ownerShopLogoUrl` (023) / `ownerShopDescription` (024) / `ownerTelegramUsername` (025) (same RPC; Store filter), `ownerBankAccounts` (`{ accountNumber, bankName?, qrImageUrl? }[]`, 031), `ownerShippingFee` (flat fee once per order per shop, 031; 0/undefined = free), `variantGroups` (`{ name, affectsPrice, options: { name, price?, imageIndex? }[] }[]`, 035 — exactly one group sets the price; `imageIndex` points into `images`), `checkoutFields` (`{ label, type: 'text'|'dropdown', required, options? }[]`, 036 — tenant-defined checkout questions)
- `CartItem`: `{ product, quantity, selectedImageIndex, selectedOptions?, unitPrice?, fieldAnswers? }` — `selectedOptions` is the chosen variant (`{ group, option }[]`), `unitPrice` snapshots the variant price at add-to-cart (cart/order lines keyed by `productId:selectedImageIndex[:variantKey]`, see `utils/variants.ts`), `fieldAnswers` snapshots checkout answers (`{ label, value }[]`, 036)
- `Order`: `id` (short random code like `K7QX-9M2R`; sequential numbers would leak volume), `items` (snapshots stamped server-side with `owner_id`/`shop_name` by `stamp_order_tenants`), `total`, `paymentMethod`, `status`, `location` (optional since 034), `phoneNumber`, `studentName` (legacy only — not collected since 036), `createdAt` (server-forced to `now()` on insert, 041), `telegramId`, `tenantIds`, `paymentProofs` (jsonb: tenant owner id → proof URL), `paymentReferences` (jsonb: tenant owner id → verified `{ provider, reference, key }`, 041), `shippingFees` (jsonb: tenant owner id → fee, 031; in `total`), `itemStatuses` (jsonb: line key → per-item status, 022/038; missing entries fall back to `status`)
- `Shopper`: `telegramId`, `firstName`, optional `lastName`/`username` (validated via `telegram-auth`)
- `Category`: arbitrary string; defaults `School Uniform`, `Stationery`, `Books`, `Sports`, `Electronics`, `Accessories`
- `Profile`: `id`, `role`, `email`, `username`, `shopName`, `telegramChatId` (per-tenant group for `telegram-order-notify`), `bankAccounts` (031; ≥1 required for tenants), `shippingFee` (031), `shopLogoUrl` (required for tenants, 023), `shopDescription` (024), `telegramUsername` (025 — shoppers DM `https://t.me/<username>`), `isActive` (037 — super admin switch; off = products vanish from `fetch_products_with_shop`, tenant cannot log in, live sessions signed out via realtime profile subscription), `paymentVerificationEnabled` (043 — super admin switch; off = shop excluded from payment verification)
- `PaymentMethod`: `bank_transfer` (the only method)
- `OrderStatus`: `pending` | `paid` | `on_the_way` | `completed`, in lifecycle order (labels in `src/constants/orderStatus.ts`: `paid` = "Order Received", `on_the_way` = "Shipped"). Set **per line item** via `update_order_item_status` (022; variant-aware keys since 038); the RPC recomputes the order-level `status` as the least-advanced item status (039).
- Prices are plain numbers; always display with `formatPrice` from `src/utils/format.ts` (whole Birr, e.g. `1,250 ETB`) — never hard-code `$` or `.toFixed(2)`.

### Images

- `assets/logo.png` is the web-optimized 192×192 header logo (~35 kB); the 1024×1024 source is `assets/icon.png`. Don't swap in a large logo — it ships in the first page load.
- Product images render through `ProductImage` (`expo-image`, memory + disk cache); missing images render a local placeholder (category color + product initial) — no external service, works offline.
- Uploads are resized to max 800px, stored in the Cloudflare R2 bucket `timor-shop-images` (served from `https://img.timor.et`, keys namespaced `products/` / `logos/` / `qrs/`) with a 400px `-thumb.jpg` companion (1-year `Cache-Control`). Clients never see R2 credentials: the `r2-upload-sign` edge function (secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`) checks the caller is a signed-in admin and returns presigned PUT URLs; the client uploads bytes straight to R2. Only the full URL is stored on the product; list views request the derived thumbnail. `scripts/migrate-images-to-r2.js` copied legacy Supabase objects and rewrote DB URLs.
- Both R2 buckets carry a CORS policy (`scripts/r2-cors.json`: origins `https://shop.timor.et` + localhost dev ports, GET/PUT/HEAD, any headers) — without it browsers block the presigned PUT at preflight and all web uploads fail (native is unaffected). The R2 token is object-scoped: bucket creation and CORS changes are done in the Cloudflare dashboard.
- Payment proofs live in the **private R2 bucket** `timor-shop-proofs` (no public access), stored on the order as bare object paths (keys unchanged since migration 040 — only the backend moved; `scripts/migrate-proofs-to-r2.js`). All access is presigned via `r2-upload-sign` (`_shared/r2Sign.ts`): shoppers upload with the anonymous `sign-proof-upload` action (max 4 keys, 10-min PUT URLs); admins view with `sign-proof-get` (admin-authed GET presign, falls back to the legacy `payment-proofs-private` Supabase bucket for unmigrated objects — as do `verify-order-payment`, `verify-payment-reference`, `telegram-order-notify`); proofs are not shown to shoppers. Bank QR codes were in `bank-qrs` (020) — now `qrs/` in R2, uploaded as-is (no resize — QRs must stay scannable), never auto-deleted.
- Cover thumbnails are prefetched when the catalog loads. `coverImageIndex` picks the card/list image.
- `utils/images.ts`: `getProductCoverImage`, `getProductGalleryImages`, `getThumbnailUrl`; `services/images.ts`: upload/delete/URL parsing.
- On web, native image modules don't run: `src/lib/image-web.ts` uses a hidden `<input type="file">` + canvas. Native-only modules are **dynamically imported** everywhere so they stay out of the web bundle.

### Checkout behavior

- Checkout collects, in order: optional delivery `location`, Ethiopian phone (required, validated by `isValidEthiopianPhoneNumber`), per-product **checkout questions** (036 — answers snapshotted onto the item's `fieldAnswers`; a tenant who needs a name adds a "Name" question — there is no fixed student-name field), then per-shop payment proof. A landmark picker (`src/constants/landmarks.ts`) fills the location.
- Only payment method: **direct bank transfer**. Checkout groups the cart by tenant and shows per shop: name, bank accounts (number + bank + QR, via `fetch_products_with_shop`), subtotal + flat shipping fee. The shopper uploads **one proof photo per shop** (`uploadPaymentProof`, 800px); every shop needs a proof before ordering.
- **Pre-order verification (041).** After each proof upload, the transaction reference is read off the receipt — web/TMA via **Tesseract.js OCR** (`src/lib/ocr.ts`, lazy CDN worker, runs on the full-resolution original — the 800px proof copy garbles small text; CBE Receipt ID / Telebirr transaction numbers only), elsewhere typed manually — when the receipt prints no brand name (Telebirr's own app), the extractor falls back to each provider's label vocabulary plus the shopper's "Paid via" hint) — and checked by `verify-payment-reference` (`verify_jwt = false`; handles CORS/OPTIONS itself — every browser-called edge function must, curl/Node tests never catch a missing preflight; gated by proof existence in the private bucket + daily precheck cap + idempotency-key replay in `payment_prechecks`). It recomputes the expected amount server-side (`_shared/variantPricing.ts`), syncs the tenant's verify.et registry (`_shared/verifyRegistry.ts`), and calls verify.et's **reference JSON API** (no image credits; legacy CBE `FT…` references additionally send the receiver account's 8-digit `suffix` — `_shared/referenceSuffix.ts`, modern Receipt IDs must not). Masked receivers (`1****8566`, `2519****1630`) are matched to the shop's own accounts by visible digits (`matchMaskedAccounts` in `_shared/verifyEvaluation.ts`) — unique match passes, different account is `wrong_recipient`, ambiguous stays review. Every response carries a `detail` reason (verify.et's error or the failed/reviewed check reasons), shown in checkout under the friendly message. Verdicts: `verified` / `not_found` (fix and retry) / `wrong_recipient` / `wrong_amount` / `already_claimed` (hard rejects — new proof required) / `unavailable` (temporary, retryable — never an invalid payment). **Place Order is gated on every shop reaching `verified`**; the `{ provider, reference, key }` per tenant lands on `orders.payment_references`.
- Orders start `pending` with proofs on `orders.payment_proofs`. `telegram-order-notify` sends each tenant their order summary **plus their proof photo**; each item's checkout answers are listed under it.
- **Order-time verification (040–041).** An AFTER INSERT orders trigger calls `verify-order-payment` (client never triggers it). Orders with `payment_references` replay the pre-order check with the **same idempotency key** (free on verify.et's side — the JSON body must stay identical, `{ bank, reference }` plus the CBE suffix when applicable); legacy orders fall back to image-based submission. Each proof is checked for completion, exact recipient account, exact amount (items + fee), prior claim (`payment_claims`), and receipt age (`RECEIPT_MAX_AGE_HOURS`, default 24). Attempts log in `payment_verifications` (`is_current` = active); queued ones complete via the signed `verify-et-webhook`. Tenants retry/approve via `retry_payment_verification` / `approve_payment_verification` on OrderDetail and in `AdminUserOrdersScreen`. Verification never changes order status — approval stays manual.
- **Runtime kill-switch (042) + per-tenant switch (043).** `platform_settings.payment_verification_enabled` (public read, super-admin write) gates the whole pipeline, and `profiles.payment_verification_enabled` excludes individual shops — a shop is verified only when BOTH are on. All three edge functions read the flags per request (missing/error = disabled, fail-safe). Flip them from Tenant Management (global switch at the top, per-shop switch on each tenant card) or with SQL: `UPDATE platform_settings SET value = 'false' WHERE key = 'payment_verification_enabled';` / `UPDATE profiles SET payment_verification_enabled = false WHERE id = '<tenant>';`. While off for a shop: checkout skips its verification (proof alone suffices, pre-040 behavior), the pre-check returns `{"skipped":"verification disabled"}` (client maps it to `unavailable`), order-time verification skips that shop's slice, and the webhook acks without touching verify.et or Telegram. `telegram-order-notify` is unaffected.
- Tenant bank details live on `profiles.bank_accounts`, the fee on `profiles.shipping_fee`: super admin sets them at tenant creation/edit; tenants maintain their own via `update_own_bank_accounts` / `update_own_shipping_fee` in Account & Security. Each fee is charged once per order, added to that shop's transfer amount, stored on `orders.shipping_fees`, included in `orders.total`.
  Merchant account editing is temporarily disabled: `MERCHANT_ACCOUNT_EDITING_ENABLED = false` in `src/constants/featureFlags.ts` hides the tenant's Account & Security editing (password, shop description, Telegram username, bank details, shipping fee incl. its Add/Edit Item field) and entry points; flip to `true` to re-enable. Super admin and RPCs unaffected.
- A checkout creates a single `Order` containing all cart line items, sharing one location and phone number.

### Persistence keys

- `@schoolshop_products` / `@schoolshop_orders` / `@schoolshop_categories` (caches)
- `@schoolshop_cart` (cart)
- `@schoolshop_shopper` (validated Telegram shopper)
- `@onlineshop_theme`

---

## Supabase setup

1. Create a project at https://supabase.com and copy the **Project URL** and **anon public API key**.
2. Create `.env` from `.env.example`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<your-anon-public-key>
   ```
3. Apply migrations in order — `supabase/migrations/001_initial_schema.sql` through `043_tenant_verification_toggle.sql` from the SQL Editor, or `supabase db push` if linked.
4. Enable **Email auto-confirm** (Authentication > Providers > Email) so tenant accounts are immediately active.
5. Create the super admin: `node scripts/setup-admin.js` (needs `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` in `.env`).
6. Mini App: `supabase functions deploy telegram-auth`, set the `TELEGRAM_BOT_TOKEN` secret (from @BotFather). Full steps in `docs/telegram-mini-app.md`.
7. Order notifications: `supabase functions deploy telegram-order-notify` (needs `TELEGRAM_BOT_TOKEN` and `PUBLISHABLE_KEY`; per-tenant chat ids in `profiles.telegram_chat_id`). Tenants without a chat id are skipped — order placement unaffected. A group upgraded to a supergroup gets its new chat id adopted automatically.
8. Payment verification: `supabase functions deploy verify-order-payment verify-payment-reference verify-et-webhook`; secrets `VERIFY_ET_API_KEY`, `VERIFY_FUNCTION_SECRET` (also `SELECT vault.create_secret('<same>', 'verify_function_secret')`), `VERIFY_ET_WEBHOOK_SECRET` (webhook URL `…/functions/v1/verify-et-webhook`), optionally `RECEIPT_MAX_AGE_HOURS` (default 24). Test with genuine CBE/Telebirr receipts via `scripts/test-reference-verification.js` before going live.
9. Image storage (R2): `supabase functions deploy r2-upload-sign`; secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`, `R2_PROOFS_BUCKET`. Buckets `timor-shop-images` (public, custom domain `img.timor.et`) and `timor-shop-proofs` (private — create it in the Cloudflare dashboard; the token can't create buckets). Legacy Supabase objects: `node scripts/migrate-images-to-r2.js --apply --delete` and `node scripts/migrate-proofs-to-r2.js --apply --delete`.
9. Start the app. It begins with empty products, orders, and categories.

---

## Code style guidelines

- TypeScript `"strict": true`. Avoid implicit `any`; keep types explicit.
- Named exports (`export function Foo()`); functional components and hooks only.
- Components live in `src/components/` or `src/screens/`.
- Styles colocated with `StyleSheet.create()`, referencing `src/constants/theme.ts` tokens.
- Import order: React / navigation hooks, components, context, types, constants.
- `colors.surface` for white/card backgrounds, `colors.background` for page backgrounds.
- Use `SafeAreaView` via the `Screen` component; reuse `Screen`, `Button`, `EmptyState`.
- Web-specific UI is gated with `Platform.OS === 'web'` checks.

---

## Testing instructions

No test framework is configured. Before adding tests, choose a stack consistent with Expo (e.g. Jest with `jest-expo` + React Native Testing Library). Type check with:

```bash
npx tsc --noEmit
```

No ESLint or Prettier config exists; if you add one, keep rules aligned with the existing style.

---

## Security considerations

- **Admin authentication.** Supabase Auth. Roles: `super_admin` (full) and `admin` (tenant; edits only own products). `get_admin_by_username` returns data only for an exact match.
  Credential management (013): admins change own username/password in Account & Security; super admin edits tenant credentials via SECURITY DEFINER RPCs. A guard trigger blocks non-super-admins from changing any profile's `role`/`email`.
  Tenant codes (014): every profile gets a short `XXXX-XXXX` code from `fill_tenant_code` — the auth UUID is never shown in the UI. Tenant creation accepts an optional custom email (blank derives `<username>@tenant.schoolshop.app`); the signup trigger detects tenants by the `shop_name` metadata field.
  `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` must NOT use the `EXPO_PUBLIC_` prefix — that inlines values into the client bundle. Anyone who discovers the tenant email pattern can create a tenant account; lock down with an invitation flow beyond the MVP.
- **Public reads, authenticated writes.** Products/categories publicly readable; orders placed without auth. Order SELECT is public (016) so Telegram shoppers can read history by `telegram_id` — order rows (phone, location) are readable by anyone with the anon key. Harden beyond the MVP.
- **Payment verification trust boundary (040–042).** Orders are inserted by anonymous clients, so nothing on the order is trusted: `verify-order-payment` recomputes the expected amount from the catalog (`_shared/variantPricing.ts` + `profiles.shipping_fee`), `created_at` is forced to `now()` by trigger (041), and the atomic claim (`payment_claims` PK on `(provider, reference)`, ON CONFLICT read-back) fails closed on DB errors. Concurrent orders for one reference: exactly one claim wins; the loser fails `notPreviouslyClaimed`.
- **Local cache.** AsyncStorage is unencrypted. Never store real payment data, passwords, or PII.
- **Telegram shopper identity.** `telegram-auth` validates Telegram's signed initData, so the shopper record is trustworthy — but orders carry a client-supplied `telegram_id` under public-insert RLS, so a crafted client could forge another user's id (hardening option in `docs/telegram-mini-app.md`).
  initData HMAC gotcha: `secret_key = HMAC(key="WebAppData", message=bot_token)` — swapping key/message silently rejects every real initData. If the SDK script fails (slow networks), `initTelegram()` falls back to a stub WebApp from the `tgWebAppData` URL parameter (callers check `hasTelegramChrome()`).
- Storage objects are not auto-deleted when a product is removed (best-effort deletion).
