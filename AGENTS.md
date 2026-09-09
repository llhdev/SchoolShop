# Timor Shop — Agent Guide

This file is written for AI coding agents working on the **Timor Shop** project. It summarizes the technology stack, architecture, conventions, and how to build and run the app. When in doubt, prefer the actual source code over this document, and always consult the exact versioned docs for the framework versions listed below.

---

## Project overview

**Timor Shop** is a cross-platform mobile app built with **Expo SDK 54** and **React Native**. It is a student shopping MVP that lets users browse school supplies, add items to a cart, check out, and view order history. It also provides an admin mode where products and categories can be created, edited, and deleted, and where orders can be reviewed by customer phone number.

The admin layer is tenant-based: a single **super admin** manages categories and tenant admins, while each **tenant admin** can only upload products and choose from the existing categories. Tenant admins cannot add or remove categories or manage other tenants.

Admins log in by typing their **username** into the home-screen search bar. The default super admin username is `santa2024`.

Key facts:

- **Supabase** is the source of truth for products, orders, and categories. AsyncStorage is used as a local cache for instant UI rendering.
- Reads are cache-first: the app shows cached data immediately and refreshes from Supabase in the background.
- Writes are optimistic: the UI updates immediately, then syncs to Supabase. Realtime subscriptions keep clients in sync.
- No real authentication in this phase. Row Level Security policies allow public read/write for the MVP.
- No real payment gateway. Online payment is simulated.
- Supports **iOS**, **Android**, and **web** targets through Expo.
- The same web build serves **two surfaces**: the standalone website and a **Telegram Mini App** (a web app inside Telegram's WebView). One codebase, one build, one Supabase database; TMA-specific code is gated behind `isTelegramMiniApp()` and no-ops elsewhere. See `docs/telegram-mini-app.md` for the full runbook.
- Entry point: `index.ts` registers `App.tsx` as the root component.
- Web target has dedicated responsive headers (`WebHeader`, `AdminHeader`); the bottom tab bar is the navigation chrome on native and narrow web/TMA viewports.

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
| Image handling | `expo-image-picker`, `expo-image-manipulator` | Admin product images; multi-image gallery support |
| Picker | `@react-native-picker/picker` | Category selector |

Always consult the exact versioned docs before writing code: <https://docs.expo.dev/versions/v54.0.0/>.

---

## Project structure

```
.
├── App.tsx                         # Root component: AppProvider + AppNavigator
├── index.ts                        # Registers the root component with Expo
├── app.json                        # Expo app manifest
├── package.json                    # Dependencies and npm scripts
├── tsconfig.json                   # Extends expo/tsconfig.base, strict: true
├── start-app.bat                   # Windows quick-start helper
├── assets/                         # App icons, splash, favicon
├── supabase/
│   ├── functions/
│   │   ├── telegram-auth/        # Validates Telegram initData, upserts shoppers
│   │   └── telegram-order-notify/  # Posts new orders to the shop's Telegram group
│   └── migrations/
│       ├── 001_initial_schema.sql  # Supabase tables, RLS, storage bucket
│       ├── 002_admin_auth_rls.sql  # Profiles, auth triggers, admin RLS
│       ├── 003_tenant_admins.sql   # Super admin / tenant admin roles and product ownership
│       ├── 004_username_login.sql  # Username-based admin login lookup
│       ├── 005_tenant_signup_trigger.sql  # Tenant signup trigger for in-app tenant creation
│       ├── 006_tenant_shop_name.sql  # Tenant shop name column and trigger update
│       ├── 007_delete_tenant_user.sql  # Super admin tenant deletion RPC
│       ├── 008_compare_at_price.sql  # Optional compare-at price for discount display
│       ├── 009_ensure_product_columns.sql  # Idempotent guard: products.description
│       ├── 010_remove_stock_column.sql  # Idempotent guard: drop products.stock
│       ├── 011_telegram_shoppers.sql  # Shoppers table + orders.telegram_id for the TMA
│       ├── 012_order_status_update.sql  # Super-admin-only UPDATE policy on orders
│       └── 013_account_management.sql  # Self-service gateway change, super-admin tenant editing, role/email guard trigger
│       └── 014_tenant_codes.sql  # Short XXXX-XXXX tenant codes, tenant detection by signup metadata (custom emails)
│       └── 015_order_telegram_backfill.sql  # RPC for a shopper to stamp its telegram_id onto its own NULL-telegram_id orders
│       └── 016_restore_shopper_order_read.sql  # Re-adds public SELECT on orders (002's admin-only SELECT silently broke TMA shopper history + realtime)
│       └── 017_product_shop_names.sql  # SECURITY DEFINER RPC fetch_products_with_shop(): catalog + tenant shop_name (profiles is not anon-readable)
├── docs/
│   └── telegram-mini-app.md      # TMA runbook: architecture, deploy, bot setup, testing
├── .github/workflows/deploy-web.yml  # CI: web export -> gh-pages on push to main
├── scripts/
│   └── prep-dist.js              # SPA fallback (404.html) + .nojekyll for static hosts
└── src/
    ├── components/                 # Reusable UI components
    │   ├── AdminHeader.tsx         # Web-only admin navigation header
    │   ├── Button.tsx              # Primary / secondary / danger / outline buttons (optional loading spinner)
    │   ├── CartItemRow.tsx         # Cart line item with quantity controls
    │   ├── CategoryFilter.tsx      # Horizontal category chips + "More" dropdown
    │   ├── EmptyState.tsx          # Empty list placeholder with icon
    │   ├── ProductCard.tsx         # Product grid card (price, discount badge, shop name, quick add — quick-add hidden inside the Mini App)
    │   ├── ProductImage.tsx        # Cached product image (expo-image) + local placeholder
    │   ├── Screen.tsx              # Safe-area wrapper with optional scroll/padding
    │   ├── SearchBar.tsx           # Text input with search/clear icons
    │   └── WebHeader.tsx           # Web-only Timor Shop header
    ├── constants/
    │   ├── categories.ts           # Default category list, colors, and color helper
    │   ├── landmarks.ts            # Common Addis Ababa delivery landmarks for checkout
    │   └── theme.ts                # Colors (brand palette from logo), spacing, font sizes, radius, breakpoints
    ├── context/
    │   └── AppContext.tsx          # Global state, reducer, actions, and persistence hooks
    ├── data/
    │   └── seedProducts.ts         # Default product catalog
    ├── hooks/
    │   └── useResponsive.ts        # useWindowDimensions-based breakpoint helper
    ├── lib/
    │   ├── debounce.ts             # Trailing debounce helper (realtime refetch coalescing)
    │   ├── image-web.ts            # Web/TMA admin image pipeline (file input + canvas resize)
    │   ├── supabase.ts             # Supabase client init with persistent auth storage
    │   └── telegram.ts             # Telegram Mini App SDK wrapper (lazy, no-ops outside TMA)
    ├── navigation/
    │   ├── AppNavigator.tsx        # Root native-stack navigator; role-based routing; screens code-split via React.lazy (Home eager)
    │   ├── AdminStackNavigator.tsx # Admin screens stack (loaded as a lazy chunk)
    │   └── UserTabNavigator.tsx    # Student bottom-tabs (Home eager; Cart/Orders lazy chunks)
    ├── screens/
    │   ├── admin/
    │   │   ├── AdminDashboardScreen.tsx  # Product/category management and stats
    │   │   ├── AdminOrdersScreen.tsx     # Orders grouped by customer phone number
    │   │   ├── AdminUserOrdersScreen.tsx # All orders for a single phone number
    │   │   ├── AddEditItemScreen.tsx     # Create/edit product with multi-image upload
    │   │   └── TenantManagementScreen.tsx # Super admin tenant management
    │   └── user/
    │       ├── HomeScreen.tsx            # Product grid with search, category filter, new arrivals
    │       ├── ProductDetailScreen.tsx   # Product gallery, details, add to cart; in the Mini App a full-screen page with a bottom Add to Cart / Buy bar (Buy goes straight to checkout)
    │       ├── CartScreen.tsx            # Cart review and checkout navigation
    │       ├── CheckoutScreen.tsx        # Delivery info, Ethiopian phone validation, payment
    │       ├── OrdersScreen.tsx          # User order history
    │       └── OrderDetailScreen.tsx     # Single order details
    ├── services/
    │   ├── cache.ts                # AsyncStorage cache helpers
    │   ├── categories.ts           # Category CRUD + realtime
    │   ├── images.ts               # Supabase Storage upload/delete
    │   ├── orders.ts               # Order CRUD + realtime (admin + per-telegram-shopper)
    │   ├── products.ts             # Product CRUD + realtime
    │   ├── telegramAuth.ts         # Exchanges signed TMA initData for the shopper record
    │   ├── telegramOrderNotify.ts  # Fire-and-forget post-order Telegram group notification
    │   └── tenants.ts              # Tenant admin list/delete
    ├── types/
    │   ├── index.ts                # Domain types (Product, Order, CartItem, etc.)
    │   └── navigation.ts           # React Navigation param lists
    └── utils/
        ├── format.ts               # ETB price formatting (formatPrice) + discount percent
        ├── images.ts               # Cover/gallery helpers, thumbnail URL derivation, resize
        ├── storage.ts              # AsyncStorage read/write for theme only
        └── validation.ts           # Ethiopian phone number validation
```

---

## Build and run commands

Requirements:

- Node.js `22+`
- npm `10+`
- Expo Go app on a physical device, or an Android/iOS emulator

Install dependencies and start the development server:

```bash
npm install
npm start
```

Run on a specific platform:

```bash
npm run android   # Android emulator or connected device
npm run ios       # iOS simulator (macOS only)
npm run web       # Web browser
```

Build and deploy the web bundle (website + Telegram Mini App share it):

```bash
npm run build:web   # static export to dist/ (baseUrl /SchoolShop from app.json)
npm run deploy:web  # export + SPA fallback/.nojekyll, publish to gh-pages branch
```

`.github/workflows/deploy-web.yml` runs the same export and publishes to GitHub Pages on every push to `main` (requires the `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` repository secrets).

Windows quick start: double-click `start-app.bat`, which opens a terminal, runs `npm start`, and keeps the window open.

---

## Architecture notes

### State management

All shared state lives in `src/context/AppContext.tsx`:

- A single `useReducer` manages `role`, `products`, `cart`, `orders`, and `categories`.
- On first mount the app loads products, orders, categories, and the cart from the AsyncStorage cache immediately so the UI renders without waiting on the network.
- A background sync then fetches fresh data from Supabase and replaces the local cache and state.
- Mutations are optimistic: the reducer updates local state first, the cache is updated, and then the change is sent to Supabase. If the call fails, the local change is rolled back.
- Supabase Realtime subscriptions listen for product, order, and category changes and refresh the local state + cache automatically (refetches are debounced so bursts of events trigger a single fetch).
- Orders are admin-only: shoppers never fetch or subscribe to the global order list — their order history is the orders placed on that device (cached locally). Admins fetch all orders and receive realtime updates while signed in; signing out clears the order list from memory and cache.
- Inside the Telegram Mini App, a validated `shopper` (from the `telegram-auth` Edge Function, cached at `@schoolshop_shopper`) gives the shopper server-side order history: orders are fetched and subscribed by `telegram_id` and follow the Telegram account across devices. This path is skipped while an admin is signed in.
- The Supabase client persists auth sessions via AsyncStorage, so admin sign-in survives app restarts.
- Derived values (`cartTotal`, `cartCount`) are computed at render time.

Actions:

- `SET_ROLE`, `SET_PRODUCTS`, `ADD_PRODUCT`, `UPDATE_PRODUCT`, `DELETE_PRODUCT`
- `ADD_TO_CART`, `SET_CART`, `REMOVE_FROM_CART`, `UPDATE_CART_QUANTITY`, `CLEAR_CART`
- `SET_ORDERS`, `ADD_ORDER`, `UPDATE_ORDER`, `DELETE_ORDER`
- `SET_CATEGORIES`, `ADD_CATEGORY`, `REMOVE_CATEGORY`

### Navigation

`AppNavigator.tsx` switches the root navigator based on `role`:

- `role === 'user'` → `UserTabs` plus `ProductDetail`, `Checkout`, `OrderDetail`, and a hidden `AdminLogin` route
- `role === 'admin'` or `role === 'super_admin'` → `AdminStack` plus shared `ProductDetail` and `OrderDetail`

The app starts as a shopper by default.

Admins reach `AdminLogin` by typing their **username** into the home-screen search bar. The app looks up the username via `get_admin_by_username` and, if found, opens the admin login screen pre-filled with that admin's email. The admin then enters their password.

The default super admin username is `santa2024` (set by `scripts/setup-admin.js`).

Tenant admins are created in-app from the **Tenant Management** screen. The super admin enters a username, password, and shop name; the app derives a tenant email (`<username>@tenant.schoolshop.app`) and calls `supabase.auth.signUp()` with a secondary, in-memory client so the super admin's session is preserved. The Postgres trigger `on_auth_user_created` then creates the profile with `role='admin'`, the chosen username, and the shop name. Existing tenants are listed by shop name and creation date; tapping a tenant opens a detail screen with full account information. Tenant deletion uses the `delete_tenant_user` RPC so the super admin can permanently remove the tenant's auth account (their username and password will no longer work).

Within the admin stack:
- `super_admin` sees category management, tenant management, and all products.
- `admin` (tenant admin) sees only products they uploaded and can choose from existing categories.

Param lists are defined in `src/types/navigation.ts`.

On web the `NavigationContainer` has a `linking` config (`product/:productId`, `cart`, `orders`, `checkout`, `order/:orderId`) that strips the `/SchoolShop` GitHub Pages base path. Inside the Telegram Mini App the React Navigation header is hidden — it would overlap Telegram's BackButton — and the BackButton is driven from navigation state instead (`AppNavigator.tsx`).

### Data model

- `Product`: `id`, `name`, `description`, `price`, `compareAtPrice` (optional higher "original" price for discount display), `category`, `images` (string array), `coverImageIndex`, `createdAt`, `ownerId`, `shopName` (optional tenant shop name, resolved server-side via the `fetch_products_with_shop` RPC and shown as small text under the product name)
- `CartItem`: `{ product, quantity, selectedImageIndex }`
- `Order`: `id` (short random code like `K7QX-9M2R`, generated at checkout from an unambiguous letter/digit alphabet; sequential numbers were rejected because they leak order volume), `items`, `total`, `paymentMethod`, `status`, `location`, `phoneNumber`, `createdAt`, `telegramId` (optional, set for Mini App orders)
- `Shopper`: `telegramId`, `firstName`, optional `lastName`/`username` (validated via the `telegram-auth` Edge Function)
- `Category`: arbitrary string; defaults are `School Uniform`, `Stationery`, `Books`, `Sports`, `Electronics`, `Accessories`
- `Profile`: `id`, `role`, `email`, `username`, `shopName`
- `PaymentMethod`: `cash_on_delivery` | `online_payment`
- `OrderStatus`: `pending` | `paid` | `delivered` | `completed` | `failed`. `pending`/`paid` are set at checkout; `completed`/`failed` are terminal states set by the super admin from the order detail screen (RLS: only `is_super_admin()` may UPDATE orders — migration 012).
- Prices are plain numbers; always display them with `formatPrice` from `src/utils/format.ts` (whole Birr, e.g., `1,250 ETB`) — never hard-code `$` or `.toFixed(2)`.

### Images

- `assets/logo.png` is the web-optimized 192×192 header logo (~35 kB); the full-resolution 1024×1024 source lives in `assets/icon.png` (used for app icons). Don't swap in a large logo — it ships in the first page load.
- Product images render through `ProductImage` (`src/components/ProductImage.tsx`), a wrapper around `expo-image` with memory + disk caching and fade-in transitions.
- Missing images render a local placeholder (category-colored surface + product initial) — no external placeholder service is used, so the UI works offline.
- Uploads are resized to a max width of 800px and stored in the Supabase Storage `product-images` bucket along with a 400px `-thumb.jpg` companion, both served with a 1-year `Cache-Control` so repeat views are cached. Only the full URL is stored on the product record; list views request the derived thumbnail and fall back to the full image when a thumbnail does not exist.
- Cover thumbnails are prefetched into the expo-image disk cache when the product catalog loads, so scrolling on slow connections finds images already cached.
- Products support multiple images. `coverImageIndex` selects which image is shown in cards and lists.
- `utils/images.ts` provides `getProductCoverImage`, `getProductGalleryImages`, and `getThumbnailUrl`.
- `services/images.ts` handles upload (full + thumbnail), deletion, and URL parsing.
- On web (browser + Mini App WebView) `expo-image-picker`/`expo-image-manipulator`/`expo-file-system` don't run: `src/lib/image-web.ts` picks files via a hidden `<input type="file">` and resizes with canvas. The native-only modules are **dynamically imported** everywhere so they stay out of the web bundle.

### Checkout behavior

- The checkout screen collects a delivery `location` and an Ethiopian phone number.
- A "Choose a common location" picker (`src/constants/landmarks.ts`) fills the location field with a well-known Addis Ababa landmark; the shopper can edit it to add dorm/block details.
- Phone numbers are validated with `isValidEthiopianPhoneNumber` in `src/utils/validation.ts`.
- Cash on delivery creates orders with `pending` status; online payment creates orders with `paid` status.
- A checkout creates a single `Order` containing all cart line items, sharing the same location and phone number.

### Persistence keys

AsyncStorage is only used for the local cache and theme:

- `@schoolshop_products` (cache)
- `@schoolshop_orders` (cache)
- `@schoolshop_categories` (cache)
- `@schoolshop_cart` (cart persistence)
- `@schoolshop_shopper` (validated Telegram shopper)
- `@onlineshop_theme`

---

## Supabase setup

1. Create a project at https://supabase.com.
2. Copy the **Project URL** and **anon public API key**.
3. Create a `.env` file in the project root from `.env.example`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<your-anon-public-key>
   ```
4. Run the migrations in order from the Supabase SQL Editor:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_admin_auth_rls.sql`
   - `supabase/migrations/003_tenant_admins.sql`
   - `supabase/migrations/004_username_login.sql`
   - `supabase/migrations/005_tenant_signup_trigger.sql`
   - `supabase/migrations/006_tenant_shop_name.sql`
   - `supabase/migrations/007_delete_tenant_user.sql`
   - `supabase/migrations/008_compare_at_price.sql`
   - `supabase/migrations/009_ensure_product_columns.sql`
   - `supabase/migrations/010_remove_stock_column.sql`
   - `supabase/migrations/011_telegram_shoppers.sql`
   - `supabase/migrations/012_order_status_update.sql` through `015_order_telegram_backfill.sql`
   (or run `supabase db push` from the `supabase/` directory if the CLI is linked to the project)
5. Enable **Email auto-confirm** in Authentication > Providers > Email (or set `mailer_autoconfirm` to `true` via the Management API). This is required so tenant accounts created in-app are immediately active.
6. Create the super admin by running `node scripts/setup-admin.js` (requires `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` in `.env`).
7. For the Telegram Mini App: deploy the Edge Function with `supabase functions deploy telegram-auth` (from `supabase/`), then set the `TELEGRAM_BOT_TOKEN` secret (from @BotFather) in Dashboard > Edge Functions > Secrets. Full bot and deploy steps are in `docs/telegram-mini-app.md`.
8. For order notifications: deploy with `supabase functions deploy telegram-order-notify` and set the `TELEGRAM_ORDER_CHAT_ID` secret (the Telegram group the bot posts new orders to; see `docs/telegram-mini-app.md`). Without the secret the function logs and returns `{ notified: false }` — order placement is unaffected.
8. Start the app. It begins with empty products, orders, and categories so you can add your own.

---

## Code style guidelines

- TypeScript is configured with `"strict": true`. Avoid implicit `any` and keep types explicit.
- Use named exports for components and helpers (`export function Foo()`).
- Components live in `src/components/` or `src/screens/`.
- Prefer functional components and hooks; the project does not use class components.
- Styles are colocated in each file using `StyleSheet.create()` and reference tokens from `src/constants/theme.ts`.
- Import order observed in existing files: React / navigation hooks, then components, then context, then types, then constants.
- Use `colors.surface` for white/card backgrounds and `colors.background` for page backgrounds.
- Use `SafeAreaView` from `react-native-safe-area-context` via the `Screen` component.
- Keep screens pure of layout concerns where possible; reuse `Screen`, `Button`, and `EmptyState`.
- Web-specific UI (headers, footers, hover cursors) is gated with `Platform.OS === 'web'` checks.

---

## Testing instructions

The project currently has **no test framework configured** and no test files. Before adding tests, choose a stack consistent with the Expo/React Native ecosystem (for example, Jest with `jest-expo` and React Native Testing Library) and update `package.json` scripts accordingly.

Type checking can be run manually with the installed TypeScript compiler:

```bash
npx tsc --noEmit
```

There is no ESLint or Prettier configuration present. If you add one, keep rules aligned with the existing code style.

---

## Security considerations

- **Admin authentication.** Admin access requires signing in through Supabase Auth. Two admin roles exist:
  - `super_admin`: full access; can manage categories, tenant admins, and all products.
  - `admin`: tenant admin; can upload products and choose from existing categories, but can only edit/delete products they uploaded.
  Admins are found by typing their `username` into the home-screen search bar. The `get_admin_by_username` RPC only returns data for an exact username match.
  Credential management (migration 013): any admin can change their own gateway and password from the Account & Security screen (`change_own_username` RPC + `auth.updateUser`). The super admin can additionally edit a tenant's username, email, shop name, and password (Tenant detail → Edit Account; `admin_update_tenant` / `admin_set_tenant_password` RPCs write to `profiles` and `auth.users` as SECURITY DEFINER with a super-admin check). A guard trigger blocks non-super-admins from changing any profile's `role` or `email`.
  Tenant codes (migration 014): every profile gets a short `XXXX-XXXX` code (same format as order codes) assigned by the `fill_tenant_code` trigger — the auth UUID is never shown in the UI. Tenant creation accepts an optional custom email (blank derives `<username>@tenant.schoolshop.app`); the signup trigger detects tenants by the `shop_name` metadata field, not the email domain.
  The super admin is created with `scripts/setup-admin.js` using `SUPABASE_ADMIN_EMAIL` and `SUPABASE_ADMIN_PASSWORD` (these must NOT use the `EXPO_PUBLIC_` prefix — that prefix inlines values into the client bundle). Tenant admins are created in-app via `supabase.auth.signUp()` from the super admin's session. The tenant email domain (`tenant.schoolshop.app`) and the `on_auth_user_created` trigger ensure the new profile is created with `role='admin'`. Anyone who discovers the tenant email pattern can create a tenant account in this MVP; lock this down with an invitation flow or Edge Function validation if you move beyond the MVP.
- **No real payment processing.** Card details entered on the checkout screen are validated only by length and are never transmitted or stored securely.
- **Public reads, authenticated writes.** Products and categories are readable by everyone so shoppers can browse. Orders can be placed without auth. Order SELECT is public (migration 016) so Telegram shoppers can read their own history by `telegram_id` and receive Realtime updates — note this means order rows (phone, location) are readable by anyone with the anon key. Harden with per-shopper JWT claims if the app moves beyond the MVP.
- **Local cache.** AsyncStorage data is stored unencrypted on the device. Do not store real payment data, passwords, or PII in this app.
- **Telegram shopper identity.** The `telegram-auth` Edge Function validates Telegram's signed initData, so the shopper record it returns is trustworthy. However, orders are inserted by the client with that `telegram_id`, and RLS still allows public inserts — a crafted client could forge another user's `telegram_id` (see `docs/telegram-mini-app.md` for the hardening option). Orders are admin-reviewed before COD delivery.
  initData HMAC gotcha: `secret_key = HMAC(key="WebAppData", message=bot_token)` — swapping key/message silently rejects every real initData. The client SDK script (`telegram.org/js/telegram-web-app.js`) can fail on slow networks; `initTelegram()` then falls back to a stub WebApp built from the `tgWebAppData` URL parameter so shopper identity still works (native chrome stays inert — callers check `hasTelegramChrome()` to fall back to in-app UI).
- Admin product images are uploaded to Supabase Storage. Storage objects are not automatically deleted when a product is removed (deletion is best-effort).

---

## Useful references

- Expo SDK 54 docs: <https://docs.expo.dev/versions/v54.0.0/>
- React Navigation v7: <https://reactnavigation.org/docs/getting-started/>
- AsyncStorage: <https://react-native-async-storage.github.io/async-storage/>
- Supabase JavaScript client: <https://supabase.com/docs/reference/javascript/>
- Supabase Realtime: <https://supabase.com/docs/guides/realtime>
