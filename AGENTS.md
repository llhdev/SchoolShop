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
- Entry point: `index.ts` registers `App.tsx` as the root component.
- Web target has dedicated responsive headers (`WebHeader`, `AdminHeader`) and a footer on the home screen; native targets use the standard bottom tab navigator and screen headers.

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
│   └── migrations/
│       ├── 001_initial_schema.sql  # Supabase tables, RLS, storage bucket
│       ├── 002_admin_auth_rls.sql  # Profiles, auth triggers, admin RLS
│       ├── 003_tenant_admins.sql   # Super admin / tenant admin roles and product ownership
│       ├── 004_username_login.sql  # Username-based admin login lookup
│       ├── 005_tenant_signup_trigger.sql  # Tenant signup trigger for in-app tenant creation
│       ├── 006_tenant_shop_name.sql  # Tenant shop name column and trigger update
│       └── 007_delete_tenant_user.sql  # Super admin tenant deletion RPC
└── src/
    ├── components/                 # Reusable UI components
    │   ├── AdminHeader.tsx         # Web-only admin navigation header
    │   ├── Button.tsx              # Primary / secondary / danger / outline buttons
    │   ├── CartItemRow.tsx         # Cart line item with quantity controls
    │   ├── CategoryFilter.tsx      # Horizontal category chips + "More" dropdown
    │   ├── EmptyState.tsx          # Empty list placeholder with icon
    │   ├── ProductCard.tsx         # Product grid card
    │   ├── Screen.tsx              # Safe-area wrapper with optional scroll/padding
    │   ├── SearchBar.tsx           # Text input with search/clear icons
    │   └── WebHeader.tsx           # Web-only Timor Shop header
    ├── constants/
    │   ├── categories.ts           # Default category list, colors, and color helper
    │   └── theme.ts                # Colors, spacing, font sizes, border radius, breakpoints
    ├── context/
    │   └── AppContext.tsx          # Global state, reducer, actions, and persistence hooks
    ├── data/
    │   └── seedProducts.ts         # Default product catalog
    ├── hooks/
    │   └── useResponsive.ts        # useWindowDimensions-based breakpoint helper
    ├── lib/
    │   └── supabase.ts             # Supabase client initialization
    ├── navigation/
    │   ├── AppNavigator.tsx        # Root native-stack navigator; role-based routing
    │   ├── AdminStackNavigator.tsx # Admin screens stack
    │   └── UserTabNavigator.tsx    # Student bottom-tabs (Home, Cart, Orders)
    ├── screens/
    │   ├── admin/
    │   │   ├── AdminDashboardScreen.tsx  # Product/category management and stats
    │   │   ├── AdminOrdersScreen.tsx     # Orders grouped by customer phone number
    │   │   ├── AdminUserOrdersScreen.tsx # All orders for a single phone number
    │   │   ├── AddEditItemScreen.tsx     # Create/edit product with multi-image upload
    │   │   └── TenantManagementScreen.tsx # Super admin tenant management
    │   └── user/
    │       ├── HomeScreen.tsx            # Product grid with search, category filter, new arrivals
    │       ├── ProductDetailScreen.tsx   # Product gallery, details, add to cart / buy now
    │       ├── CartScreen.tsx            # Cart review and checkout navigation
    │       ├── CheckoutScreen.tsx        # Delivery info, Ethiopian phone validation, payment
    │       ├── OrdersScreen.tsx          # User order history
    │       └── OrderDetailScreen.tsx     # Single order details
    ├── services/
    │   ├── cache.ts                # AsyncStorage cache helpers
    │   ├── categories.ts           # Category CRUD + realtime
    │   ├── images.ts               # Supabase Storage upload/delete
    │   ├── orders.ts               # Order CRUD + realtime
    │   ├── products.ts             # Product CRUD + realtime
    │   └── tenants.ts              # Tenant admin list/delete
    ├── types/
    │   ├── index.ts                # Domain types (Product, Order, CartItem, etc.)
    │   └── navigation.ts           # React Navigation param lists
    └── utils/
        ├── images.ts               # Placeholder image generation + cover/gallery helpers
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

Windows quick start: double-click `start-app.bat`, which opens a terminal, runs `npm start`, and keeps the window open.

---

## Architecture notes

### State management

All shared state lives in `src/context/AppContext.tsx`:

- A single `useReducer` manages `role`, `products`, `cart`, `orders`, and `categories`.
- On first mount the app loads products, orders, and categories from the AsyncStorage cache immediately so the UI renders without waiting on the network.
- A background sync then fetches fresh data from Supabase and replaces the local cache and state.
- Mutations are optimistic: the reducer updates local state first, the cache is updated, and then the change is sent to Supabase. If the call fails, the local change is rolled back.
- Supabase Realtime subscriptions listen for product, order, and category changes and refresh the local state + cache automatically.
- Derived values (`cartTotal`, `cartCount`) are computed at render time.

Actions:

- `SET_ROLE`, `SET_PRODUCTS`, `ADD_PRODUCT`, `UPDATE_PRODUCT`, `DELETE_PRODUCT`
- `ADD_TO_CART`, `REMOVE_FROM_CART`, `UPDATE_CART_QUANTITY`, `CLEAR_CART`
- `SET_ORDERS`, `ADD_ORDER`, `DELETE_ORDER`
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

### Data model

- `Product`: `id`, `name`, `description`, `price`, `category`, `images` (string array), `coverImageIndex`, `createdAt`, `ownerId`
- `CartItem`: `{ product, quantity }`
- `Order`: `id`, `items`, `total`, `paymentMethod`, `status`, `location`, `phoneNumber`, `createdAt`
- `Category`: arbitrary string; defaults are `School Uniform`, `Stationery`, `Books`, `Sports`, `Electronics`, `Accessories`
- `Profile`: `id`, `role`, `email`, `username`, `shopName`
- `PaymentMethod`: `cash_on_delivery` | `online_payment`
- `OrderStatus`: `pending` | `paid` | `delivered`

### Images

- Placeholder images are generated with `placehold.co`, colored by category.
- Products support multiple images. `coverImageIndex` selects which image is shown in cards and lists.
- Admin image uploads allow multiple selections and are resized to a max width of 800px.
- Resized images are uploaded to the Supabase Storage `product-images` bucket; the product record stores the public URL.
- `utils/images.ts` provides `getProductCoverImage` and `getProductGalleryImages` for cover and gallery rendering.
- `services/images.ts` handles upload, deletion, and URL parsing.

### Checkout behavior

- The checkout screen collects a delivery `location` and an Ethiopian phone number.
- Phone numbers are validated with `isValidEthiopianPhoneNumber` in `src/utils/validation.ts`.
- Cash on delivery creates orders with `pending` status; online payment creates orders with `paid` status.
- Each cart line item becomes a separate `Order` entry, sharing the same location and phone number.

### Persistence keys

AsyncStorage is only used for the local cache and theme:

- `@onlineshop_products` (cache)
- `@onlineshop_orders` (cache)
- `@onlineshop_categories` (cache)
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
5. Enable **Email auto-confirm** in Authentication > Providers > Email (or set `mailer_autoconfirm` to `true` via the Management API). This is required so tenant accounts created in-app are immediately active.
6. Create the super admin by running `node scripts/setup-admin.js` (requires `SUPABASE_SERVICE_ROLE_KEY` and `EXPO_PUBLIC_ADMIN_EMAIL`/`EXPO_PUBLIC_ADMIN_PASSWORD` in `.env`).
7. Start the app. It begins with empty products, orders, and categories so you can add your own.

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
  The super admin is created with `scripts/setup-admin.js` using `EXPO_PUBLIC_ADMIN_EMAIL` and `EXPO_PUBLIC_ADMIN_PASSWORD`. Tenant admins are created in-app via `supabase.auth.signUp()` from the super admin's session. The tenant email domain (`tenant.schoolshop.app`) and the `on_auth_user_created` trigger ensure the new profile is created with `role='admin'`. Anyone who discovers the tenant email pattern can create a tenant account in this MVP; lock this down with an invitation flow or Edge Function validation if you move beyond the MVP.
- **No real payment processing.** Card details entered on the checkout screen are validated only by length and are never transmitted or stored securely.
- **Public reads, authenticated writes.** Products and categories are readable by everyone so shoppers can browse. Orders can be placed without auth, but order history is only visible to admins in this MVP. Lock this down further with shopper authentication if you need per-user order history.
- **Local cache.** AsyncStorage data is stored unencrypted on the device. Do not store real payment data, passwords, or PII in this app.
- **Placeholder images** are loaded from an external service (`placehold.co`) over HTTPS. If network access is restricted, those images will not render.
- Admin product images are uploaded to Supabase Storage. Storage objects are not automatically deleted when a product is removed (deletion is best-effort).

---

## Useful references

- Expo SDK 54 docs: <https://docs.expo.dev/versions/v54.0.0/>
- React Navigation v7: <https://reactnavigation.org/docs/getting-started/>
- AsyncStorage: <https://react-native-async-storage.github.io/async-storage/>
- Supabase JavaScript client: <https://supabase.com/docs/reference/javascript/>
- Supabase Realtime: <https://supabase.com/docs/guides/realtime>
