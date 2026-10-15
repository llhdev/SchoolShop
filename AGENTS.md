# Timor Shop — Agent Guide

Agent guide for the **Timor Shop** project: stack, architecture, conventions, and how to build and run. Prefer the actual source code over this document when they disagree, and consult the exact versioned docs for the framework versions listed below.

---

## Project overview

**Timor Shop** is a cross-platform mobile app built with **Expo SDK 54** and **React Native**. It is a student shopping MVP: users browse school supplies, add items to a cart, check out, and view order history. An admin mode lets products and categories be created, edited, and deleted, and orders reviewed by customer phone number.

The admin layer is tenant-based: a single **super admin** manages categories and tenant admins, while each **tenant admin** can only upload products and choose from the existing categories. Tenant admins cannot manage categories or other tenants.

Admins log in by typing their **username** into the home-screen search bar. The default super admin username is `santa2024`.

Key facts:

- **Supabase** is the source of truth for products, orders, and categories; AsyncStorage is a local cache for instant UI rendering.
- Reads are cache-first (show cache immediately, refresh from Supabase in background); writes are optimistic (update UI, then sync). Realtime subscriptions keep clients in sync.
- No real authentication in this phase. RLS policies allow public read/write for the MVP.
- No real payment gateway: shoppers pay each tenant by direct bank transfer and upload a photo as proof; no money moves through the app.
- Supports **iOS**, **Android**, and **web** through Expo.
- The same web build serves **two surfaces**: the standalone website and a **Telegram Mini App** (a web app inside Telegram's WebView). One codebase, one build, one Supabase database; TMA-specific code is gated behind `isTelegramMiniApp()` and no-ops elsewhere. See `docs/telegram-mini-app.md`.
- Entry point: `index.ts` registers `App.tsx` as the root component.
- Web has dedicated responsive headers (`WebHeader`, `AdminHeader`); the bottom tab bar is the navigation chrome on native and narrow web/TMA viewports.

---

## Technology stack

| Layer | Technology | Version / Notes |
|-------|------------|-----------------|
| Framework | Expo SDK | `~54.0.36` (managed workflow) |
| UI library | React Native | `0.81.5` |
| Web runtime | react-native-web | `^0.21.0` |
| React | react / react-dom | `19.1.0` |
| Language | TypeScript | `~5.9.2`, strict mode enabled |
| Navigation | React Navigation v7 | `@react-navigation/native` + native-stack + bottom-tabs |
| State | React Context + `useReducer` | Global state in `src/context/AppContext.tsx` |
| Backend / Database | Supabase | `@supabase/supabase-js` — Postgres + Realtime |
| Local cache | AsyncStorage | `@react-native-async-storage/async-storage@2.2.0` |
| File storage | Supabase Storage | `product-images` bucket for admin uploads |
| Styling | React Native `StyleSheet` | Design tokens in `src/constants/theme.ts` |
| Icons | `@expo/vector-icons` | Ionicons glyph set |
| Image handling | `expo-image-picker`, `expo-image-manipulator` | Admin product images; multi-image gallery |
| Picker | `@react-native-picker/picker` | Category selector |

Docs: <https://docs.expo.dev/versions/v54.0.0/>

---

## Project structure

```
.
├── App.tsx                          # Root component: AppProvider + AppNavigator
├── index.ts                         # Registers the root component with Expo
├── app.json / package.json / tsconfig.json   # Expo manifest, deps+scripts, strict TS
├── start-app.bat                    # Windows quick-start helper
├── assets/                          # App icons, splash, favicon
├── supabase/
│   ├── functions/
│   │   ├── telegram-auth/           # Validates Telegram initData, upserts shoppers
│   │   ├── telegram-order-notify/   # Routes each order to the Telegram group of every shop in it
│   │   ├── verify-order-payment/    # DB-triggered verify.et check of each merchant's payment proof
│   │   └── verify-et-webhook/       # Completes queued verifications (signed, idempotent)
│   └── migrations/                  # 001–040, applied in order; header comments document each
├── docs/
│   └── telegram-mini-app.md         # TMA runbook: architecture, deploy, bot setup, testing
├── .github/workflows/deploy-web.yml # CI: web export -> gh-pages on push to main
├── scripts/
│   ├── prep-dist.js                 # SPA fallback (404.html) + .nojekyll for static hosts
│   ├── setup-admin.js               # Creates/updates the super admin (service role)
│   ├── reset-data.js                # Clears orders/products/categories (anon key)
│   └── clean-database.js            # Deletes all tenants/products/orders/categories/shoppers +
│                                    # storage; keeps only the super admin (CLEAN_USERNAME/CLEAN_PASSWORD)
└── src/
    ├── components/                  # Reusable UI components
    │   ├── AdminHeader.tsx          # Web-only admin navigation header
    │   ├── BankAccountsEditor.tsx   # Editable shop bank-account list (number + bank name + QR)
    │   ├── Button.tsx               # Primary / secondary / danger / outline buttons (optional spinner)
    │   ├── CartItemRow.tsx          # Cart line item with quantity controls
    │   ├── CategoryFilter.tsx       # Chips: "All", "Store" filter, categories + "More" dropdown
    │   ├── EmptyState.tsx           # Empty list placeholder with icon
    │   ├── ProductCard.tsx          # Grid card (price, discount badge, shop name, quick add — hidden in Mini App)
    │   ├── ProductImage.tsx         # Cached product image (expo-image) + local placeholder
    │   ├── ImageViewerModal.tsx     # Fullscreen swipeable viewer opened from a product image
    │   ├── Screen.tsx               # Safe-area wrapper with optional scroll/padding
    │   ├── SearchBar.tsx            # Text input with search/clear icons
    │   ├── StoreList.tsx            # Inline store picker opened by the "Store" chip; replaces the grid until picked
    │   ├── VerificationBadge.tsx    # verify.et status chip (Verified / Needs review / …) for admin order views
    │   └── WebHeader.tsx            # Web-only Timor Shop header
    ├── constants/
    │   ├── categories.ts            # Default category list, colors, color helper
    │   ├── landmarks.ts             # Common Addis Ababa delivery landmarks for checkout
    │   └── theme.ts                 # Colors, spacing, font sizes, radius, breakpoints
    ├── context/
    │   └── AppContext.tsx           # Global state, reducer, actions, persistence hooks
    ├── data/
    │   └── seedProducts.ts          # Default product catalog
    ├── hooks/
    │   └── useResponsive.ts         # useWindowDimensions-based breakpoint helper
    ├── lib/
    │   ├── debounce.ts              # Trailing debounce (realtime refetch coalescing)
    │   ├── image-web.ts             # Web/TMA admin image pipeline (file input + canvas resize)
    │   ├── supabase.ts              # Supabase client init with persistent auth storage
    │   └── telegram.ts              # Telegram Mini App SDK wrapper (lazy, no-ops outside TMA)
    ├── navigation/
    │   ├── AppNavigator.tsx         # Root stack; role-based routing; React.lazy code-splitting (Home eager)
    │   ├── AdminStackNavigator.tsx  # Admin screens stack (lazy chunk)
    │   └── UserTabNavigator.tsx     # Student bottom-tabs (Home eager; Cart/Orders lazy)
    ├── screens/
    │   ├── admin/
    │   │   ├── AdminDashboardScreen.tsx   # Product/category management and stats
    │   │   ├── AdminOrdersScreen.tsx      # Orders grouped by customer phone
    │   │   ├── AdminAnalysisScreen.tsx    # Shopper table aggregated from orders (per-shop for tenants)
    │   │   ├── AdminUserOrdersScreen.tsx  # All orders for one phone number
    │   │   ├── AddEditItemScreen.tsx      # Create/edit product, multi-image upload, variant editor, checkout questions
    │   │   └── TenantManagementScreen.tsx # Super admin tenant management
    │   └── user/
    │       ├── HomeScreen.tsx           # Product grid with search, category filter, new arrivals
    │       ├── ProductDetailScreen.tsx  # Gallery, details, variant picker, add to cart; in the Mini App
    │       │                            # a bottom Add to Cart / Buy bar (Buy goes straight to checkout)
    │       ├── CartScreen.tsx           # Cart review and checkout navigation
    │       ├── CheckoutScreen.tsx       # Delivery info, phone validation, payment
    │       ├── OrdersScreen.tsx         # Order history — one card per item, per-item status badge
    │       └── OrderDetailScreen.tsx    # Single order details
    ├── services/
    │   ├── cache.ts                 # AsyncStorage cache helpers
    │   ├── categories.ts            # Category CRUD + realtime
    │   ├── images.ts                # Supabase Storage upload/delete
    │   ├── orders.ts                # Order CRUD + realtime (admin + per-telegram-shopper)
    │   ├── paymentVerifications.ts  # verify.et verification reads + retry/approve RPC wrappers (040)
    │   ├── products.ts              # Product CRUD + realtime
    │   ├── telegramAuth.ts          # Exchanges signed TMA initData for the shopper record
    │   ├── telegramOrderNotify.ts   # Fire-and-forget post-order Telegram group notification
    │   └── tenants.ts               # Tenant admin list/delete
    ├── types/
    │   ├── index.ts                 # Domain types (Product, Order, CartItem, etc.)
    │   └── navigation.ts            # React Navigation param lists
    └── utils/
        ├── format.ts                # ETB price formatting (formatPrice) + discount percent
        ├── images.ts                # Cover/gallery helpers, thumbnail URL derivation, resize
        ├── storage.ts               # AsyncStorage read/write for theme only
        ├── validation.ts            # Ethiopian phone number validation
        ├── variants.ts              # Variant selection keys, unit-price resolution, labels, DB jsonb mapping
        └── checkoutFields.ts        # Checkout question validation + DB jsonb mapping (036)
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

The production deploy target is **Vercel**: `vercel.json` builds with `expo export --platform web`, serves `dist/`, and rewrites all paths to `index.html` (SPA fallback). Deploy with `vercel deploy --prod` or the GitHub integration; `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` must be set on the Vercel project (inlined at build time).

The legacy GitHub Pages pipeline still exists: `npm run deploy:web` publishes `dist/` to `gh-pages`, and `.github/workflows/deploy-web.yml` does the same on push to `main` (needs the same two repository secrets).

---

## Architecture notes

### State management

All shared state lives in `src/context/AppContext.tsx`:

- A single `useReducer` manages `role`, `products`, `cart`, `orders`, and `categories`.
- On mount the app loads everything from the AsyncStorage cache so the UI renders without the network, then a background sync fetches fresh data from Supabase.
- Mutations are optimistic: the reducer updates local state, the cache is updated, then the change is sent to Supabase; failures roll back.
- Supabase Realtime subscriptions listen for product, order, and category changes and refresh state + cache (refetches are debounced so bursts trigger a single fetch).
- Orders are admin-only: shoppers never fetch the global order list — their history is the orders placed on that device (cached locally). The super admin fetches all orders; tenant admins fetch only orders whose `tenant_ids` include them (migration 018) and see only their shop's line items within mixed orders. Signing out clears the order list from memory and cache.
- The Shopper Analysis screen (`AdminAnalysisScreen`) aggregates the same tenant-scoped order list client-side into one row per shopper phone number (orders, units, spend incl. the shop's shipping fee, last order); no extra fetch or migration. Tapping a row opens `AdminUserOrders` for that phone.
- Inside the Telegram Mini App, a validated `shopper` (from the `telegram-auth` Edge Function, cached at `@schoolshop_shopper`) gives server-side order history: orders are fetched and subscribed by `telegram_id` and follow the Telegram account across devices. Skipped while an admin is signed in.
- The Supabase client persists auth sessions via AsyncStorage, so admin sign-in survives restarts.
- Derived values (`cartTotal`, `cartCount`) are computed at render time.

Actions: `SET_ROLE`, `SET_PRODUCTS`, `ADD_PRODUCT`, `UPDATE_PRODUCT`, `DELETE_PRODUCT`, `ADD_TO_CART`, `SET_CART`, `REMOVE_FROM_CART`, `UPDATE_CART_QUANTITY`, `CLEAR_CART`, `SET_ORDERS`, `ADD_ORDER`, `UPDATE_ORDER`, `DELETE_ORDER`, `SET_CATEGORIES`, `ADD_CATEGORY`, `REMOVE_CATEGORY`.

### Navigation

`AppNavigator.tsx` switches the root navigator based on `role`:

- `role === 'user'` → `UserTabs` plus `ProductDetail`, `Checkout`, `OrderDetail`, and a hidden `AdminLogin` route
- `role === 'admin'` / `'super_admin'` → `AdminStack` plus shared `ProductDetail` and `OrderDetail`

The app starts as a shopper. Admins reach `AdminLogin` by typing their **username** into the home-screen search bar; `get_admin_by_username` resolves it and the login screen opens pre-filled with the admin's email, then they enter their password.

Tenant admins are created in-app from **Tenant Management**: the super admin enters a username, password, and shop name; the app derives a tenant email (`<username>@tenant.schoolshop.app`) and calls `supabase.auth.signUp()` with a secondary, in-memory client so the super admin's session is preserved. The `on_auth_user_created` trigger then creates the profile with `role='admin'`. Tenant deletion uses the `delete_tenant_user` RPC to permanently remove the auth account; migration 026 also deletes every product the tenant uploaded.

Within the admin stack:
- `super_admin` sees category management, tenant management, and all products — but never posts items (Add Item is hidden and blocked). Their Orders screen lists the tenants; tapping a shop shows that shop's orders grouped by customer phone, scoped to its line items.
- `admin` (tenant) sees only products they uploaded and chooses from existing categories.

Param lists are in `src/types/navigation.ts`. On web the `NavigationContainer` has a `linking` config (`product/:productId`, `cart`, `orders`, `checkout`, `order/:orderId`) anchored at the domain root (`WEB_BASE_PATH` in `AppNavigator.tsx`). Inside the Mini App the React Navigation header is hidden (it would overlap Telegram's BackButton), which is driven from navigation state instead.

### Data model

- `Product`: `id`, `name`, `description`, `price`, `compareAtPrice` (optional higher "original" price for discount display), `category`, `images` (string array), `detailImages` (optional extra photos listed under the description, migration 027), `priceHidden` ("price on request", migration 029 — no price tag, no cart/buy; shoppers order via the shop's Telegram chat, price stored as 0), `orderCount` (units ordered, server-maintained by `on_order_created_increment_counts`, migration 030 — powers the Popular sort), `coverImageIndex`, `createdAt`, `ownerId`, `shopName` (optional, resolved server-side via `fetch_products_with_shop`), `ownerShopLogoUrl` (023) / `ownerShopDescription` (024) (from the same RPC, used by the Store filter), `ownerTelegramUsername` (025 — powers the chat-with-shop icon; the order detail page reads the username stamped onto each item snapshot), `ownerBankAccounts` (list of `{ accountNumber, bankName?, qrImageUrl? }`, 031 — shown at checkout), `ownerShippingFee` (flat fee charged once per order per shop, 031; undefined/0 = free), `variantGroups` (list of `{ name, affectsPrice, options: { name, price?, imageIndex? }[] }`, 035 — variations like Size/Color; exactly one group may set the price, an option's `imageIndex` points into `images`), `checkoutFields` (list of `{ label, type: 'text' | 'dropdown', required, options? }`, 036 — tenant-defined questions the buyer answers at checkout, e.g. Name / ID number / Campus branch)
- `CartItem`: `{ product, quantity, selectedImageIndex, selectedOptions?, unitPrice?, fieldAnswers? }` — `selectedOptions` is the chosen variant (`{ group, option }[]`), `unitPrice` snapshots the variant price at add-to-cart (both absent for products without variants; cart/order lines are keyed by `productId:selectedImageIndex[:variantKey]`, see `utils/variants.ts`), `fieldAnswers` snapshots the buyer's checkout-question answers (`{ label, value }[]`, 036) onto the order item
- `Order`: `id` (short random code like `K7QX-9M2R`; sequential numbers were rejected — they leak order volume), `items` (each snapshot stamped server-side with `owner_id`/`shop_name` by the `stamp_order_tenants` trigger), `total`, `paymentMethod`, `status`, `location` (optional since 034), `phoneNumber`, `studentName` (legacy only — no longer collected at checkout since 036), `createdAt`, `telegramId` (Mini App orders), `tenantIds` (scopes tenant admin order lists), `paymentProofs` (jsonb: tenant owner id → proof photo URL), `shippingFees` (jsonb: tenant owner id → fee charged, 031; included in `total`), `itemStatuses` (jsonb: `productId:selectedImageIndex[:variantKey]` → per-item status, 022/038; missing entries fall back to `status`)
- `Shopper`: `telegramId`, `firstName`, optional `lastName`/`username` (validated via `telegram-auth`)
- `Category`: arbitrary string; defaults are `School Uniform`, `Stationery`, `Books`, `Sports`, `Electronics`, `Accessories`
- `Profile`: `id`, `role`, `email`, `username`, `shopName`, `telegramChatId` (per-tenant Telegram group chat id for `telegram-order-notify`), `bankAccounts` (031; at least one required for tenants), `shippingFee` (031; NULL/0 = free), `shopLogoUrl` (required for tenants, 023; super-admin editable, Store filter), `shopDescription` (024; Store filter), `telegramUsername` (025; shoppers tap a chat icon on the product detail page and per order line item to DM `https://t.me/<username>`), `isActive` (037 — super admin switch; off = the shop's products vanish from `fetch_products_with_shop` for everyone, the tenant cannot log in, and a live session is signed out via a realtime profile subscription)
- `PaymentMethod`: `bank_transfer` (the only method)
- `OrderStatus`: `pending` | `paid` | `on_the_way` | `completed`, in lifecycle order (labels: `paid` = "Order Received", `on_the_way` = "Shipped" — see `src/constants/orderStatus.ts`). Set **per line item** by the super admin or owning tenant admin via `update_order_item_status` (022; item keys are variant-aware since 038); the RPC also recomputes the order-level `status` as the least-advanced item status (039), which is the fallback label for items without an explicit entry.
- Prices are plain numbers; always display with `formatPrice` from `src/utils/format.ts` (whole Birr, e.g. `1,250 ETB`) — never hard-code `$` or `.toFixed(2)`.

### Images

- `assets/logo.png` is the web-optimized 192×192 header logo (~35 kB); the 1024×1024 source is `assets/icon.png`. Don't swap in a large logo — it ships in the first page load.
- Product images render through `ProductImage` (a wrapper around `expo-image` with memory + disk caching). Missing images render a local placeholder (category-colored surface + product initial) — no external placeholder service, works offline.
- Uploads are resized to max 800px and stored in the `product-images` bucket with a 400px `-thumb.jpg` companion, both with 1-year `Cache-Control`. Only the full URL is stored on the product; list views request the derived thumbnail and fall back to the full image.
- Payment proofs uploaded after migration 040 live in the **private** `payment-proofs-private` bucket and are stored on the order as bare object paths; older orders hold full public `payment-proofs` URLs. Server-side readers use the service role; admins view proofs via short-lived signed URLs; proofs are no longer shown to shoppers. Bank QR codes (`bank-qrs` bucket, 020) stay public-read, uploaded as-is via `uploadSingleImage` (no thumbnail/resize — QR codes must stay scannable), never auto-deleted.
- Cover thumbnails are prefetched into the expo-image disk cache when the catalog loads.
- Products support multiple images; `coverImageIndex` picks the card/list image.
- `utils/images.ts` provides `getProductCoverImage`, `getProductGalleryImages`, `getThumbnailUrl`; `services/images.ts` handles upload, deletion, URL parsing.
- On web `expo-image-picker`/`expo-image-manipulator`/`expo-file-system` don't run: `src/lib/image-web.ts` picks files via a hidden `<input type="file">` and resizes with canvas. Native-only modules are **dynamically imported** everywhere so they stay out of the web bundle.

### Checkout behavior

- The checkout screen collects, in order: optional delivery `location`, Ethiopian phone number (required), then per-product **checkout questions** (036 — defined by the tenant on each product as text or dropdown fields, required or optional; the buyer answers them once per cart line and the answers are snapshotted onto the order item's `fieldAnswers`), then per-shop payment proof. There is no fixed student-name field since 036 — a tenant who needs a name adds a "Name" question. Legacy orders keep `orders.student_name` and the order detail screen shows it only when present.
- A "Choose a common location" picker (`src/constants/landmarks.ts`) fills the location field; the shopper can edit it to add dorm/block details.
- Phone numbers are validated with `isValidEthiopianPhoneNumber` in `src/utils/validation.ts`.
- The only payment method is **direct bank transfer**. Checkout groups the cart by tenant and shows, per shop: name, every bank account (number + bank name + QR, via `fetch_products_with_shop`), the shop's subtotal plus its flat shipping fee. The shopper uploads **one payment-proof photo per shop** (`uploadPaymentProof`, resized to 800px); every shop needs a proof before the order can be placed.
- Orders start at `pending` with proofs on `orders.payment_proofs`. The `telegram-order-notify` Edge Function sends each tenant their order summary **plus their payment-proof photo** to their Telegram chat; each item's checkout-question answers are listed under it.
- **Payment verification (verify.et, migration 040).** An AFTER INSERT orders trigger calls the `verify-order-payment` Edge Function (client never triggers it). Each merchant's proof is checked for completion, exact recipient account, exact amount (items + fee), prior claim (`payment_claims`), and receipt age (`RECEIPT_MAX_AGE_HOURS`, default 24). Attempts are logged in `payment_verifications` (`is_current` = active); queued ones complete via the signed `verify-et-webhook`. Tenants retry/approve via `retry_payment_verification` / `approve_payment_verification`, surfaced on the order detail screen and as chips in `AdminUserOrdersScreen`. Verification never changes order status — approval stays manual.
- Tenant bank details live on `profiles.bank_accounts` and the fee on `profiles.shipping_fee`: the super admin sets them at tenant creation/edit; tenants maintain their own via `update_own_bank_accounts` / `update_own_shipping_fee` in Account & Security. Each fee is charged once per order, added to that shop's transfer amount, stored on `orders.shipping_fees`, and included in `orders.total`.
  Merchant account editing is temporarily disabled: `MERCHANT_ACCOUNT_EDITING_ENABLED = false` in `src/constants/featureFlags.ts` hides the tenant's Account & Security editing (gateway, password, shop description, Telegram username, bank details, shipping fee — including the shipping-fee field on Add/Edit Item) and its entry points; flip to `true` to re-enable. The super admin and the RPCs are unaffected.
- A checkout creates a single `Order` containing all cart line items, sharing one location and phone number.

### Persistence keys

- `@schoolshop_products` / `@schoolshop_orders` / `@schoolshop_categories` (caches)
- `@schoolshop_cart` (cart persistence)
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
3. Apply migrations in order — run `supabase/migrations/001_initial_schema.sql` through `040_payment_verifications.sql` from the Supabase SQL Editor, or `supabase db push` if the CLI is linked.
4. Enable **Email auto-confirm** (Authentication > Providers > Email) so tenant accounts created in-app are immediately active.
5. Create the super admin with `node scripts/setup-admin.js` (needs `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` in `.env`).
6. Mini App: `supabase functions deploy telegram-auth`, then set the `TELEGRAM_BOT_TOKEN` secret (from @BotFather) in Dashboard > Edge Functions > Secrets. Full steps in `docs/telegram-mini-app.md`.
7. Order notifications: `supabase functions deploy telegram-order-notify` (needs `TELEGRAM_BOT_TOKEN` and `PUBLISHABLE_KEY` — the `sb_publishable_…` key accepted by the auth gate alongside the legacy anon JWT; per-tenant chat ids live in `profiles.telegram_chat_id`). Tenants without a chat id are skipped — order placement is unaffected. If a tenant's group is upgraded to a supergroup, the function adopts the new chat id automatically; see the troubleshooting section in `docs/telegram-mini-app.md`.
8. Payment verification (verify.et): `supabase functions deploy verify-order-payment verify-et-webhook`, set secrets `VERIFY_ET_API_KEY`, `VERIFY_FUNCTION_SECRET` (also stored in the DB via `SELECT vault.create_secret('<same>', 'verify_function_secret')`), `VERIFY_ET_WEBHOOK_SECRET` (from the verify.et dashboard webhook setup; webhook URL is `…/functions/v1/verify-et-webhook`), and optionally `RECEIPT_MAX_AGE_HOURS` (default 24). An AFTER INSERT trigger on orders calls the function — verification never runs from the client.
9. Start the app. It begins with empty products, orders, and categories.

---

## Code style guidelines

- TypeScript `"strict": true`. Avoid implicit `any`; keep types explicit.
- Named exports for components and helpers (`export function Foo()`); functional components and hooks only.
- Components live in `src/components/` or `src/screens/`.
- Styles are colocated with `StyleSheet.create()` and reference tokens from `src/constants/theme.ts`.
- Import order: React / navigation hooks, then components, then context, then types, then constants.
- `colors.surface` for white/card backgrounds, `colors.background` for page backgrounds.
- Use `SafeAreaView` via the `Screen` component; reuse `Screen`, `Button`, and `EmptyState`.
- Web-specific UI is gated with `Platform.OS === 'web'` checks.

---

## Testing instructions

No test framework is configured. Before adding tests, choose a stack consistent with Expo (e.g. Jest with `jest-expo` + React Native Testing Library) and update `package.json` scripts. Type check with:

```bash
npx tsc --noEmit
```

No ESLint or Prettier config exists; if you add one, keep rules aligned with the existing style.

---

## Security considerations

- **Admin authentication.** Admins sign in through Supabase Auth. Roles: `super_admin` (full access) and `admin` (tenant; can only edit/delete products they uploaded). `get_admin_by_username` only returns data for an exact username match.
  Credential management (013): admins change their own username/password from Account & Security; the super admin edits tenant username/email/shop name/password via SECURITY DEFINER RPCs. A guard trigger blocks non-super-admins from changing any profile's `role` or `email`.
  Tenant codes (014): every profile gets a short `XXXX-XXXX` code from the `fill_tenant_code` trigger — the auth UUID is never shown in the UI. Tenant creation accepts an optional custom email (blank derives `<username>@tenant.schoolshop.app`); the signup trigger detects tenants by the `shop_name` metadata field.
  `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` must NOT use the `EXPO_PUBLIC_` prefix — that inlines values into the client bundle. Anyone who discovers the tenant email pattern can create a tenant account in this MVP; lock this down with an invitation flow beyond the MVP.
- **Public reads, authenticated writes.** Products and categories are publicly readable; orders can be placed without auth. Order SELECT is public (016) so Telegram shoppers can read their history by `telegram_id` — order rows (phone, location) are readable by anyone with the anon key. Harden with per-shopper JWT claims beyond the MVP.
- **Local cache.** AsyncStorage is unencrypted. Never store real payment data, passwords, or PII.
- **Telegram shopper identity.** `telegram-auth` validates Telegram's signed initData, so the shopper record is trustworthy — but orders are inserted by the client with that `telegram_id` under public-insert RLS, so a crafted client could forge another user's id (see `docs/telegram-mini-app.md` for the hardening option).
  initData HMAC gotcha: `secret_key = HMAC(key="WebAppData", message=bot_token)` — swapping key/message silently rejects every real initData. The client SDK script can fail on slow networks; `initTelegram()` then falls back to a stub WebApp built from the `tgWebAppData` URL parameter (callers check `hasTelegramChrome()` to fall back to in-app UI).
- Storage objects are not auto-deleted when a product is removed (best-effort deletion).
