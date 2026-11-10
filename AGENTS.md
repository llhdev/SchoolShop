# Timor Shop — Agent Guide

Stack, architecture, conventions, build and run. When this doc and the code disagree, the code wins.

Deep-dive references (read on demand, kept out of this file to stay under the size limit):

- `docs/architecture.md` — images/R2 pipeline, checkout + payment-verification detail
- `docs/supabase-setup.md` — fresh-backend setup steps
- `docs/security.md` — auth model, RLS posture, trust boundaries
- `docs/staging-setup.md` — staging environment runbook
- `docs/telegram-mini-app.md` — Telegram Mini App runbook

---

## Project overview

**Timor Shop** is a cross-platform mobile app built with **Expo SDK 54** and **React Native**. A student shopping MVP: browse school supplies, cart, checkout, order history. An admin mode manages products, categories, and orders.

The admin layer is tenant-based: a single **super admin** manages categories and tenant admins; each **tenant admin** only uploads products and picks from existing categories. Admins log in by typing their **username** into the home-screen search bar. Default super admin username: `santa2024`.

Key facts:

- **Supabase** is the source of truth; AsyncStorage is a local cache for instant UI.
- Reads are cache-first; writes are optimistic (update UI, then sync). Realtime subscriptions keep clients in sync.
- No real authentication or payment gateway in this phase: RLS allows public read/write; shoppers pay tenants by direct bank transfer and upload a proof photo.
- Supports **iOS**, **Android**, and **web** through Expo.
- One web build serves **two surfaces**: the standalone website and a **Telegram Mini App**. TMA-specific code is gated behind `isTelegramMiniApp()` and no-ops elsewhere. See `docs/telegram-mini-app.md`.
- Web has dedicated headers (`WebHeader`, `AdminHeader`); the bottom tab bar is the chrome on native and narrow web/TMA.

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
| UI helpers | `@expo/vector-icons` (Ionicons), `expo-image-picker`, `expo-image-manipulator`, `@react-native-picker/picker` | icons, admin uploads, category selector |

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
│   │   ├── r2-upload-sign/          # presigned R2 access: capability-gated PUT/delete + proof GET (052), anon proof PUT/book GET
│   │   └── verify-et-webhook/       # completes queued verifications (signed, idempotent)
│   └── migrations/                  # 001–052, in order; header comments document each
├── docs/
│   ├── architecture.md              # images + checkout/payment-verification deep-dive
│   ├── staging-setup.md             # staging env runbook (dev branch → preview → staging Supabase)
│   ├── supabase-setup.md            # fresh-backend setup steps
│   ├── security.md                  # auth model, RLS posture, trust boundaries
│   └── telegram-mini-app.md         # TMA runbook
├── .github/workflows/deploy-web.yml # CI: web export -> gh-pages on push to main
├── scripts/                         # prep-dist.js, setup-admin.js, reset-data.js,
│                                    # clean-database.js, test-reference-verification.js
└── src/
    ├── components/                  # shared UI (Screen, Button, EmptyState, ProductCard,
    │                                # ProductImage, SearchBar, WebHeader, AdminHeader, …)
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
    │                                # settings (042), telegramAuth, telegramOrderNotify, productFiles (044)
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

The production deploy target is **Vercel**: `vercel.json` builds with `expo export --platform web`, serves `dist/`, rewrites all paths to `index.html`. Deploy with `vercel deploy --prod`; `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` must be set as Vercel env vars (inlined at build time).

The legacy GitHub Pages pipeline still exists: `npm run deploy:web` publishes `dist/` to `gh-pages`, and `.github/workflows/deploy-web.yml` does the same on push to `main`.

---

## Staging and release workflow

Production has live users, so day-to-day work never touches it. Develop on the `dev` branch against the staging stack (staging Supabase project `timor-shop-staging`, staging R2 buckets, test Telegram bot) and deploy previews with `npm run deploy:staging` — a Vercel preview build (Preview-scoped env vars point it at staging) plus re-aliasing `https://timor-shop-staging.vercel.app`, which the test bot serves. Release only after staging passes: merge `dev` → `main`, apply new migrations to prod **first** (`supabase db push` — the CLI stays linked to prod; staging pushes always use `--db-url` with the staging pooler URL), redeploy any changed edge functions, then `npm run deploy:prod`. Full setup, credentials, and gotchas: `docs/staging-setup.md`.

---

## Architecture notes

Images and checkout/payment-verification deep-dives live in `docs/architecture.md`.

### State management

All shared state lives in `src/context/AppContext.tsx`:

- A single `useReducer` manages `role`, `products`, `cart`, `orders`, `categories`.
- On mount the app loads the AsyncStorage cache so the UI renders offline, then a background sync fetches from Supabase.
- Mutations are optimistic: reducer → cache → Supabase; failures roll back.
- Realtime subscriptions refresh state + cache on product/order/category changes (refetches debounced).
- Orders are admin-only: shoppers never fetch the global order list — their history is orders placed on that device (cached locally). Super admin fetches all; tenant admins fetch orders whose `tenant_ids` include them (018) and see only their line items in mixed orders. Sign-out clears orders from memory and cache.
- Shopper Analysis (`AdminAnalysisScreen`): tenant-scoped orders, one row per line item (order code, date, phone, Telegram name from the public-read `shoppers` table, student name, product, qty, status, one column per checkout-question label, location last). Revenue card is super-admin-only. Rows open `OrderDetail`; web exports `.xlsx` (`src/utils/exportAnalysis.ts`, SheetJS lazy).
- In the Mini App, a validated `shopper` (from `telegram-auth`, cached at `@schoolshop_shopper`) gives server-side order history by `telegram_id` across devices. Skipped while an admin is signed in.
- The Supabase client persists auth sessions via AsyncStorage, so admin sign-in survives restarts.
- Derived values (`cartTotal`, `cartCount`) are computed at render time.

Actions (full list in the reducer): `SET_ROLE`, product/cart/order/category CRUD (`SET_*` / `ADD_*` / `UPDATE_*` / `DELETE_*` / `REMOVE_*`), `CLEAR_CART`.

### Navigation

`AppNavigator.tsx` switches the root navigator on `role`:

- `user` → `UserTabs` + `ProductDetail`, `Checkout`, `OrderDetail`, hidden `AdminLogin`
- `admin` / `super_admin` → `AdminStack` + shared `ProductDetail`, `OrderDetail`

The app starts as a shopper. Typing an admin **username** into the home search bar resolves its accounts (045's `get_accounts_by_username`) and opens the login screen.

Tenant admins are created in-app from **Tenant Management**: super admin enters username, password, shop name; the app derives `<username>@tenant.schoolshop.app` and calls `supabase.auth.signUp()` with a secondary in-memory client so the super admin's session survives. The `on_auth_user_created` trigger creates the profile with `role='admin'`. Deletion uses `delete_tenant_user`; migration 026 also deletes the tenant's products.

Within the admin stack:
- `super_admin`: categories, tenants, all products — never posts items (Add Item hidden/blocked). Orders screen lists tenants; tapping a shop shows its orders grouped by customer phone, scoped to its line items.
- `admin` (tenant): only own products; picks from existing categories.

Param lists in `src/types/navigation.ts`. Web has a `linking` config (`product/:productId`, `cart`, `orders`, `checkout`, `order/:orderId`) anchored at the domain root (`WEB_BASE_PATH`). In the Mini App the RN header is hidden (would overlap Telegram's BackButton), driven from navigation state.

### Data model

- `Product`: `id`, `name`, `description`, `price`, `compareAtPrice` (optional "original" price for discount display), `category`, `images` (string array), `detailImages` (extra photos under description, 027), `priceHidden` ("price on request", 029 — no price/cart; ordered via the shop's Telegram chat, price 0), `orderCount` (server-maintained, 030 — Popular sort), `coverImageIndex`, `createdAt`, `ownerId`, `shopName` (via `fetch_products_with_shop`), `ownerShopLogoUrl` (023) / `ownerShopDescription` (024) / `ownerTelegramUsername` (025) (same RPC; Store filter), `ownerBankAccounts` (`{ accountNumber, bankName?, qrImageUrl? }[]`, 031), `ownerShippingFee` (flat fee once per order per shop, 031; 0/undefined = free), `variantGroups` (`{ name, affectsPrice, options: { name, price?, imageIndex? }[] }[]`, 035 — exactly one group sets the price; `imageIndex` points into `images`), `checkoutFields` (`{ label, type: 'text'|'dropdown', required, options? }[]`, 036 — tenant-defined checkout questions)
- `CartItem`: `{ product, quantity, selectedImageIndex, selectedOptions?, unitPrice?, fieldAnswers?, branchId?, branchName? }` — `selectedOptions` is the chosen variant (`{ group, option }[]`), `unitPrice` snapshots the variant price at add-to-cart (cart/order lines keyed by `productId:selectedImageIndex[:variantKey]`, see `utils/variants.ts`), `fieldAnswers` snapshots checkout answers (`{ label, value }[]`, 036), `branchId`/`branchName` snapshot the checkout branch choice (045, server re-validated)
- `Order`: `id` (short random code like `K7QX-9M2R`; sequential numbers would leak volume), `items` (snapshots stamped server-side with `owner_id`/`shop_name` by `stamp_order_tenants`), `total`, `paymentMethod`, `status`, `location` (optional since 034), `phoneNumber`, `studentName` (legacy only — not collected since 036), `createdAt` (server-forced to `now()` on insert, 041), `telegramId`, `tenantIds`, `paymentProofs` (jsonb: tenant owner id → proof URL), `paymentReferences` (jsonb: tenant owner id → verified `{ provider, reference, key }`, 041), `shippingFees` (jsonb: tenant owner id → fee, 031; in `total`), `itemStatuses` (jsonb: line key → per-item status, 022/038; missing entries fall back to `status`)
- `Shopper`: `telegramId`, `firstName`, optional `lastName`/`username` (validated via `telegram-auth`)
- `ProductFile` (table `product_files`, 044): downloadable PDFs attached to a product post, stored in the public R2 bucket under `books/`. Price-0 posts = free downloads (anon-readable via RLS, listed on ProductDetail; no cart/checkout — `addToCart` ignores price-0 products). Priced posts = paid: files are hidden from anon clients and revealed by the anonymous `sign-book-get` action of `r2-upload-sign` only when the buyer's order item reached `paid`; the shopper's OrderDetail then shows download buttons. Uploaded from AddEditItem's "Digital books (PDF)" section (web: `pickPdfWeb`; native: `expo-document-picker`), bytes PUT straight to R2 via the `sign` action.
- `Category`: arbitrary string; defaults `School Uniform`, `Stationery`, `Books`, `Sports`, `Electronics`, `Accessories`
- `Profile`: `id`, `role`, `email`, `username`, `shopName`, `telegramChatId` (per-tenant group for `telegram-order-notify`), `bankAccounts` (031; ≥1 required for tenants), `shippingFee` (031), `shopLogoUrl` (required for tenants, 023), `shopDescription` (024), `telegramUsername` (025 — shoppers DM `https://t.me/<username>`), `isActive` (037 — super admin switch; off = products vanish from `fetch_products_with_shop`, tenant cannot log in, live sessions signed out via realtime profile subscription), `paymentVerificationEnabled` (043 — super admin switch; off = shop excluded from payment verification), plus staff columns (045): `parentTenantId`, `staffFinancial` / `staffShop` / `staffBranch` capability toggles, `branchId`, `staffLabel`
- **Staff accounts and branches (045–048).** Each shop is run by separate logins sharing one gateway username: the owner plus staff accounts with `parent_tenant_id` → the owner and any combination of the `staff_*` toggles — Financial (marks `paid`, sees all money + payment proofs + verification actions), Shop (product CRUD; sees orders/analysis but no money totals, no proofs), Branch (marks `received`/`shipped`/`completed`, cancels from pending/received; sees proofs; scoped to their branch's items). **The owner is management-only by default (048):** it manages the shop's staff and settings (Account & Security — the owner always gets in; `MERCHANT_ACCOUNT_EDITING_ENABLED` freezes only staff), but can flip its own toggles via `update_own_capabilities` — a one-man shop turns all three on (= the old full tenant admin; pre-048 owners were grandfathered all-on). Login: the search-bar gateway calls `get_accounts_by_username` → the login screen tries each account email with the typed password — the password picks the account. Scoping uses `effective_tenant_id()` = `COALESCE(parent_tenant_id, auth.uid())` server-side and `staffSession`/`effectiveTenantId` from `useApp()` client-side. Staff are managed with the shared `StaffManager` component — by the super admin from Tenant Detail and by the owner from Account & Security (048–050 widened `admin_delete_staff`/`admin_set_tenant_password`, the profiles guard trigger, and branches/products RLS to the owner, scoped to its own shop; signups are promoted via the `promote_staff_account` RPC (RLS-safe, branch id validated); product writes need `staff_shop`). Staff are listed nested under their shop in Tenant Management. Since 052: order statuses move only through `update_order_item_status` (direct orders UPDATE/DELETE are super-admin-only), payment-verification retry/approve need `staff_financial`, shop-settings RPCs (`update_own_bank_accounts`/`update_own_shipping_fee`/description/telegram username) are owner-only, the guard trigger also protects `is_active`/`payment_verification_enabled` from owner self-edits (`branch_selection_enabled` stays the shop's own call), and deactivated shops are refused product/status writes server-side.
- **Branches are branch admins (046).** There is no standalone branches UI: creating a staff account with the Branch toggle on creates the branch (name = the account's label, so renaming the label renames the branch); toggling it off or removing the account deletes the branch. `profiles.branch_selection_enabled` (super-admin switch on Tenant Detail, default on) gives shoppers a per-shop branch dropdown at checkout (under the location/phone fields, required when visible); the choice is stamped on each order item (`branchId`/`branchName`, re-validated by `stamp_order_tenants`). Off = no dropdown, orders arrive unstamped, and branch admins see the whole shop (client-side in `getOrderItemsForScope`, server-side in `update_order_item_status`, 047). Shops without branch admins behave exactly as before. Cancelled orders surface via the Cancelled filter chip on the orders screen — never deleted.
- `Branch` (045): `id`, `tenantId`, `name`, `deliveryLocation`, `phone`, `position` (location/phone unused since 046 — branches are just names)
- `PaymentMethod`: `bank_transfer` (the only method)
- `OrderStatus`: `pending` | `received` | `paid` | `on_the_way` | `completed` | `cancelled` (045; labels in `src/constants/orderStatus.ts`: `received` = "Order Received", `on_the_way` = "Shipped"; `cancelled` is a terminal side-exit kept out of the linear `ORDER_STATUSES`). Old `paid` orders backfilled to `received`. Set **per line item** via `update_order_item_status` (022; variant-aware keys since 038; capability-gated since 045: branch staff set received/shipped/completed/cancelled, financial staff set paid, forward-only transitions for non-super-admins; the only status path for tenants — direct orders UPDATE/DELETE became super-admin-only in 052); the RPC recomputes the order-level `status` as the least-advanced non-cancelled item status (all items cancelled ⇒ order cancelled).
- Prices are plain numbers; always display with `formatPrice` from `src/utils/format.ts` (whole Birr, e.g. `1,250 ETB`) — never hard-code `$` or `.toFixed(2)`.

### Persistence keys

- `@schoolshop_products` / `@schoolshop_orders` / `@schoolshop_categories` (caches)
- `@schoolshop_cart` (cart)
- `@schoolshop_shopper` (validated Telegram shopper)
- `@onlineshop_theme`

---

## Supabase setup

See `docs/supabase-setup.md` (10 steps: project, env, migrations, email auto-confirm, super admin, Telegram bot, order notifications, payment verification, R2 storage).

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

See `docs/security.md` — admin auth + credential management, public-read/authenticated-write RLS posture, payment-verification trust boundary, Telegram initData HMAC gotcha, unencrypted local cache.
