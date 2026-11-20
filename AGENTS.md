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
| UI helpers | `@expo/vector-icons` (Ionicons), `expo-image-picker`, `expo-image-manipulator` | icons, admin uploads |

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
│   │   ├── telegram-order-notify/   # one message per order to each shop's group; verification state rides inline
│   │   ├── verify-order-payment/    # DB-triggered verify.et check of payment proofs
│   │   ├── verify-payment-reference/ # pre-order read-only reference check (checkout calls it)
│   │   ├── r2-upload-sign/          # presigned R2 access: tenant-namespaced, capability-gated
│   │   │                            # PUT/delete (061 — keys are <prefix>/<tenantId>/<name>, legacy
│   │   │                            # deletes need ownership proof) + proof GET (052); anon proof PUT
│   │   │                            # (20/hr/IP, 061) + book GET (order id + phone, 062)
│   │   └── verify-et-webhook/       # completes queued verifications (signed, idempotent)
│   └── migrations/                  # 001–067, in order; header comments document each
├── docs/
│   ├── architecture.md              # images + checkout/payment-verification deep-dive
│   ├── staging-setup.md             # staging env runbook (dev branch → preview → staging Supabase)
│   ├── supabase-setup.md            # fresh-backend setup steps
│   ├── security.md                  # auth model, RLS posture, trust boundaries
│   └── telegram-mini-app.md         # TMA runbook
├── .github/workflows/deploy-web.yml # CI: web export -> gh-pages on push to main
├── scripts/                         # prep-dist.js, setup-admin.js, reset-data.js,
│                                    # clean-database.js, test-reference-verification.js,
│                                    # prod-health-check.ps1, test-telegram-media.mjs,
│                                    # query-logs.ps1 / rest-query.ps1 (read-only prod
│                                    # diagnostics), resend-order-notifications.js
└── src/
    ├── components/                  # shared UI (Screen, Button, EmptyState, ProductCard,
    │                                # ProductImage, SearchBar, WebHeader, AdminHeader,
    │                                # OrderStatusBadge, Chip, DashedUploadButton, StatCard,
    │                                # ErrorBoundary, …)
    ├── constants/                   # categories.ts, landmarks.ts, orderStatus.ts, theme.ts
    ├── context/AppContext.tsx       # global state, reducer, actions, persistence
    ├── data/seedProducts.ts
    ├── hooks/useResponsive.ts
    ├── lib/                         # debounce, image-web, ocr (Tesseract.js receipts),
    │                                # supabase client, telegram SDK wrapper
    ├── navigation/                  # AppNavigator (root, role routing, lazy splitting),
    │                                # AdminStackNavigator, UserTabNavigator
    ├── screens/
    │   ├── admin/                   # AdminDashboard, AdminOrders, AdminAnalysis,
    │   │                            # AdminReports, AdminUserOrders, AddEditItem,
    │   │                            # TenantManagement
    │   └── user/                    # Home, ProductDetail, Cart, Checkout, Orders, OrderDetail
    ├── services/                    # cache, categories, images, orders, products, tenants,
    │                                # paymentVerifications (040), paymentVerificationCheckout (041),
    │                                # settings (042), telegramAuth, telegramOrderNotify, productFiles (044)
    ├── types/                       # index.ts (domain), navigation.ts (param lists)
    └── utils/                       # format, images, storage, validation, variants,
                                     # checkoutFields, notify (cross-platform toast),
                                     # reports (AdminReports aggregations)
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
- Orders are admin-only: the table has no public read policy (062 — the 016 world-readable policy was dropped; 065 also dropped the 002-era `is_admin()`-only read that bypassed tenant scoping). Guests re-fetch the orders their device placed via `get_order_for_shopper(order_id, phone)` — phone is required at checkout since 063, so the id+phone pair is the capability. Super admin fetches all; staff fetch via capability routing (064): financial staff (and super admin) read the table directly (tenant-scoped), non-financial staff go through `get_scoped_orders()` which strips money server-side (total, per-item prices, shipping fees, payment references, telegram_notifications; proofs only for branch staff) and applies branch scoping — and lose realtime order updates (realtime needs SELECT via the table policy), so their lists refresh on fetch. Tenant staff see only their line items in mixed orders. Sign-out clears orders from memory and cache.
- Shopper Analysis (`AdminAnalysisScreen`): tenant-scoped orders, one row per line item (order code, date, phone, Telegram name from the public-read `shoppers` table, student name, product, qty, status, one column per checkout-question label, location last). Revenue card is super-admin-only. Rows open `OrderDetail`; web exports `.xlsx` (`src/utils/exportAnalysis.ts`, SheetJS lazy — installed from the SheetJS CDN tarball, not npm; the npm registry version is unmaintained and carries known CVEs).
- Reports (`AdminReportsScreen`): client-side shop analytics over the same scoped lines (`src/utils/reports.ts` flattens orders once per render) — sales snapshot with previous-period deltas, trend chart, hot sellers, units per product, slow movers, status counts, repeat-customer rate, locations, peak times. Same scoping as Analysis; revenue hidden without the financial capability. Bar charts are plain RN views (no chart dependency).
- In the Mini App, a validated `shopper` (from `telegram-auth`, cached at `@schoolshop_shopper`) gives server-side order history by `telegram_id` across devices via `get_orders_by_telegram_id(telegram_id, token)` — the token is an HMAC of the telegram id keyed by the vault secret, issued by `telegram-auth` only after initData validation (062). Skipped while an admin is signed in.
- The Supabase client persists auth sessions via AsyncStorage, so admin sign-in survives restarts.
- Derived values (`cartTotal`, `cartCount`) are computed at render time.

Actions (full list in the reducer): `SET_ROLE`, product/cart/order/category CRUD (`SET_*` / `ADD_*` / `UPDATE_*` / `DELETE_*` / `REMOVE_*`), `CLEAR_CART`.

### Navigation

`AppNavigator.tsx` switches the root navigator on `role`:

- `user` → `UserTabs` + `ProductDetail`, `Checkout`, `OrderDetail`, hidden `AdminLogin`
- `admin` / `super_admin` → `AdminStack` + shared `ProductDetail`, `OrderDetail`

The app starts as a shopper. Typing an admin **username** into the home search bar resolves its accounts (045's `get_accounts_by_username`) and opens the login screen.

Tenant admins are created in-app from **Tenant Management**: super admin enters username, password (minimum 12 characters since 063 — `admin_set_tenant_password` enforces it and deletes the account's refresh tokens on rotation, so live sessions die), shop name; the app derives `<username>@tenant.schoolshop.app` and calls `supabase.auth.signUp()` with a secondary in-memory client so the super admin's session survives. Since 058, the signup trigger always creates `role='user'` (client-controlled metadata must never grant roles) and the app promotes the account via the super-admin-only `admin_promote_to_tenant` RPC. Deletion uses `delete_tenant_user`; migration 026 also deletes the tenant's products.

Within the admin stack:
- `super_admin`: categories, tenants, all products — never posts items (Add Item hidden/blocked). Orders screen lists tenants; tapping a shop shows its orders grouped by customer phone, scoped to its line items.
- `admin` (tenant): only own products; picks from existing categories.

Param lists in `src/types/navigation.ts`. Web has a `linking` config (`product/:productId`, `cart`, `orders`, `checkout`, `order/:orderId`) anchored at the domain root (`WEB_BASE_PATH`). The RN header never shows on web (screens render `WebHeader`/`AdminHeader` plus in-page back links instead — showing both shifted the layout between pages); on native it's hidden in the Mini App when Telegram's BackButton is available, driven from navigation state.

### Data model

- `Product`: `id`, `name`, `description`, `price`, `compareAtPrice` (optional "original" price for discount display), `category`, `images` (string array), `detailImages` (extra photos under description, 027), `priceHidden` ("price on request", 029 — no price/cart; ordered via the shop's Telegram chat, price 0), `orderCount` (server-maintained, 030 — Popular sort), `coverImageIndex`, `createdAt`, `ownerId`, `shopName` (via `fetch_products_with_shop`), `ownerShopLogoUrl` (023) / `ownerShopDescription` (024) / `ownerTelegramUsername` (025) (same RPC; Store filter), `ownerBankAccounts` (`{ accountNumber, bankName?, qrImageUrl? }[]`, 031), `ownerShippingFee` (flat fee once per order per shop, 031; 0/undefined = free), `variantGroups` (`{ name, affectsPrice, options: { name, price?, imageIndex? }[] }[]`, 035 — exactly one group sets the price; `imageIndex` points into `images`), `checkoutFields` (`{ label, type: 'text'|'dropdown', required, options? }[]`, 036 — tenant-defined checkout questions)
- `CartItem`: `{ product, quantity, selectedImageIndex, selectedOptions?, unitPrice?, fieldAnswers?, branchId?, branchName? }` — `selectedOptions` is the chosen variant (`{ group, option }[]`), `unitPrice` snapshots the variant price at add-to-cart (cart/order lines keyed by `productId:selectedImageIndex[:variantKey]`, see `utils/variants.ts`), `fieldAnswers` snapshots checkout answers (`{ label, value }[]`, 036), `branchId`/`branchName` snapshot the checkout branch choice (045, server re-validated)
- `Order`: `id` (short random code like `K7QX-9M2R`; sequential numbers would leak volume), `items` (snapshots stamped server-side with `owner_id`/`shop_name` by `stamp_order_tenants` — SECURITY DEFINER since 054, when it also began forcing `status='pending'` and wiping `item_statuses` on insert so a crafted insert can't skip the staff lifecycle), `total`, `paymentMethod`, `status`, `location` (optional since 034), `phoneNumber` (required since 063 — the order id + phone pair is the shopper-lookup capability, so the insert trigger rejects phone-less orders; the trigger also recomputes all money server-side and wipes `telegram_notifications`/`item_statuses`), `studentName` (legacy only — not collected since 036), `createdAt` (server-forced to `now()` on insert, 041), `telegramId`, `tenantIds`, `paymentProofs` (jsonb: tenant owner id → proof URL), `paymentReferences` (jsonb: tenant owner id → verified `{ provider, reference, key }`, 041; also stamped for warning passes that carry a reference, 056; or recorded manually by financial staff via `set_order_payment_reference`, 067 — key `'manual'`, duplicate-checked against `payment_claims` on save), `shippingFees` (jsonb: tenant owner id → fee, 031; in `total`), `itemStatuses` (jsonb: line key → per-item status, 022/038; missing entries fall back to `status`), `paymentWarnings` (jsonb: tenant owner id → `{ reason: 'unreadable'|'not_found'|'unavailable', detail? }`, 056 — checkout placed the order although verification couldn't confirm the payment; tag shows while the tenant still has pending/received items, and the admin orders screen has a finance-only "Needs review" filter for them), `telegram_notifications` (jsonb column, server-only — tenant owner id → `{ chat_id, message_id, kind, text }`, 057: locator + exact text of the caption-bearing Telegram order message so a late verification can edit it in place; not mapped client-side)
- `Shopper`: `telegramId`, `firstName`, optional `lastName`/`username` (validated via `telegram-auth`)
- `ProductFile` (table `product_files`, 044): downloadable PDFs attached to a product post, stored in the public R2 bucket under `books/`. Price-0 posts = free downloads (anon-readable via RLS, listed on ProductDetail; no cart/checkout — `addToCart` ignores price-0 products). Priced posts = paid: files are hidden from anon clients and revealed by the anonymous `sign-book-get` action of `r2-upload-sign` only when the caller presents the order id AND the order's phone number and the buyer's order item reached `paid` (062); the shopper's OrderDetail then shows download buttons. Uploaded from AddEditItem's "Digital books (PDF)" section (web: `pickPdfWeb`; native: `expo-document-picker`), bytes PUT straight to R2 via the `sign` action.
- `Category`: arbitrary string; defaults `School Uniform`, `Stationery`, `Books`, `Sports`, `Electronics`, `Accessories`
- `Profile`: `id`, `role`, `email`, `username`, `shopName`, `telegramChatId` (per-tenant group for `telegram-order-notify`), `bankAccounts` (031; ≥1 required for tenants), `shippingFee` (031), `shopLogoUrl` (required for tenants, 023), `shopDescription` (024), `telegramUsername` (025 — shoppers DM `https://t.me/<username>`), `isActive` (037 — super admin switch; off = products vanish from `fetch_products_with_shop`, tenant cannot log in, live sessions signed out via realtime profile subscription), `paymentVerificationEnabled` (043 — super admin switch; off = shop excluded from payment verification), plus staff columns (045): `parentTenantId`, `staffFinancial` / `staffShop` / `staffBranch` capability toggles, `branchId`, `staffLabel`
- **Staff accounts and branches (045–048).** Each shop is run by separate logins sharing one gateway username: the owner plus staff accounts with `parent_tenant_id` → the owner and any combination of the `staff_*` toggles — Financial (marks `paid`, sees all money + payment proofs + verification actions), Shop (product CRUD; sees orders/analysis but no money totals, no proofs), Branch (marks `received`/`shipped`/`completed`, cancels from pending/received; sees proofs; scoped to their branch's items). **The owner is management-only by default (048):** it manages the shop's staff and settings (Account & Security — the owner always gets in; `MERCHANT_ACCOUNT_EDITING_ENABLED` freezes only staff, but every admin can always change their own password), but can flip its own toggles via `update_own_capabilities` — a one-man shop turns all three on (= the old full tenant admin; pre-048 owners were grandfathered all-on). Login: the search-bar gateway calls `get_accounts_by_username` → the login screen tries each account email with the typed password — the password picks the account. Scoping uses `effective_tenant_id()` = `COALESCE(parent_tenant_id, auth.uid())` server-side and `staffSession`/`effectiveTenantId` from `useApp()` client-side. Staff are managed with the shared `StaffManager` component — by the super admin from Tenant Detail and by the owner from Account & Security (048–050 widened `admin_delete_staff`/`admin_set_tenant_password`, the profiles guard trigger, and branches/products RLS to the owner, scoped to its own shop; signups are promoted via the `promote_staff_account` RPC (RLS-safe, branch id validated); product writes need `staff_shop`). Staff are listed nested under their shop in Tenant Management. Since 052: order statuses move only through `update_order_item_status` (direct orders UPDATE/DELETE are super-admin-only), payment-verification retry/approve need `staff_financial`, shop-settings RPCs (`update_own_bank_accounts`/`update_own_shipping_fee`/description/telegram username) are owner-only, the guard trigger also protects `is_active`/`payment_verification_enabled` from owner self-edits (`branch_selection_enabled` stays the shop's own call), and deactivated shops are refused product/status writes server-side.
- **Branches are branch admins (046).** There is no standalone branches UI: creating a staff account with the Branch toggle on creates the branch (name = the account's label, so renaming the label renames the branch); toggling it off or removing the account deletes the branch. `profiles.branch_selection_enabled` (super-admin switch on Tenant Detail, default on) gives shoppers a per-shop branch dropdown at checkout (under the location/phone fields, required when visible); the choice is stamped on each order item (`branchId`/`branchName`, re-validated by `stamp_order_tenants`). Off = no dropdown, orders arrive unstamped, and branch admins see the whole shop (client-side in `getOrderItemsForScope`, server-side in `update_order_item_status`, 047). Unstamped items (orders from before the shop had branches) are shop-wide for branch staff even when the toggle is on (053). Shops without branch admins behave exactly as before. Cancelled orders surface via the Cancelled filter chip on the orders screen — never deleted.
- `Branch` (045): `id`, `tenantId`, `name`, `deliveryLocation`, `phone`, `position` (location/phone unused since 046 — branches are just names)
- `PaymentMethod`: `bank_transfer` (the only method)
- `OrderStatus`: `pending` | `received` | `paid` | `on_the_way` | `completed` | `cancelled` (045; labels in `src/constants/orderStatus.ts`: `received` = "Order Received", `on_the_way` = "Shipped"; `cancelled` is a terminal side-exit kept out of the linear `ORDER_STATUSES`). Old `paid` orders backfilled to `received`. Set **per line item** via `update_order_item_status` (022; variant-aware keys since 038; capability-gated since 045: branch staff set received/shipped/completed/cancelled, financial staff set paid, forward-only transitions for non-super-admins; the only status path for tenants — direct orders UPDATE/DELETE became super-admin-only in 052; since 067 a `paid` transition atomically claims the order's stored payment reference in `payment_claims`, refusing the transition when another order already used it); the RPC recomputes the order-level `status` as the least-advanced non-cancelled item status (all items cancelled ⇒ order cancelled).
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
- User feedback: `notify()` from `src/utils/notify.ts` (toast on web, Alert on native) — never raw `Alert.alert`, which is a silent no-op on react-native-web. Destructive confirms use `confirmAction`.
- Order statuses render through `OrderStatusBadge`; filter pills through `Chip`; dashed upload/pick buttons through `DashedUploadButton`; summary numbers through `StatCard`. Don't hand-roll new copies.
- Content max-widths come from `pageWidth` in theme.ts (`form` 800 / `data` 1200) — not per-screen constants.
- Money styling: red `colors.price` only for selling prices on product surfaces; totals are bold `colors.text`; line-item unit prices `colors.textSecondary`.
- Web-specific UI is gated with `Platform.OS === 'web'` checks.

---

## Testing instructions

No test framework is configured. Before adding tests, choose a stack consistent with Expo (e.g. Jest with `jest-expo` + React Native Testing Library). Type check with:

```bash
npx tsc --noEmit
```

Two targeted guards exist outside a framework:

- `node scripts/test-telegram-media.mjs` — regression tests for the Telegram proof-routing logic (imports the real `supabase/functions/telegram-order-notify/media.ts`; run after touching that function).
- `powershell -NoProfile -File scripts/prod-health-check.ps1 [-WindowHours N]` — read-only prod checks: realtime publication membership, Telegram failure lines, order→notify coverage, deployed function version. Run after every migration/deploy.

No ESLint or Prettier config exists; if you add one, keep rules aligned with the existing style.

---

## Security considerations

See `docs/security.md` — admin auth + credential management, public-read/authenticated-write RLS posture, payment-verification trust boundary, Telegram initData HMAC gotcha, unencrypted local cache.
