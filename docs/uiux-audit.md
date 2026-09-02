# Timor Shop — UI/UX & Performance Audit

**Audience:** Ethiopian university/high-school students (16–25), mid-range Android (360–414px), intermittent 3G/4G, cash-on-delivery dominant, price-sensitive.
**Scope:** component structure, styling, routing, state management, performance, and Telegram Mini App (TMA) migration readiness.
**Status legend:** ✅ implemented in this pass · ⬜ reported for a later pass

---

## Critical blockers (fix before scaling)

### B1 — Images: no cache, no downscaling ⬜
- **Problem:** Every product image renders through the RN core `<Image>` (`ProductCard.tsx:54`, `ProductDetailScreen.tsx`, `OrdersScreen.tsx`, `CartItemRow.tsx`) — no disk cache on Android or web, so every screen mount re-downloads on 3G. Worse, the same full-resolution upload (~800px, set by `resizeImage` in `src/utils/images.ts:30`) is fetched to fill 164px-wide grid cards; `getProductCoverImage` (`src/utils/images.ts:18`) returns the raw Supabase URL with no width variant. Roughly 3–4× wasted bandwidth on the exact network this audience has. No per-image placeholder/spinner either — images pop in abruptly or stay blank.
- **Proposed solution:** Adopt `expo-image` (memory + disk cache, fade-in, placeholders) for all product image surfaces, and append Supabase image-transform params for list thumbnails (e.g. `?width=400&quality=70` — requires enabling Supabase image transformations, or pre-generate variants on upload). Keep full URLs only in the detail gallery.
- **Impact:** biggest single perf win; faster home grid on 3G, less data spend (users buy data bundles), fewer abandoned sessions. **Effort M / Impact H**

### B2 — Realtime = full-table refetch per event ⬜
- **Problem:** `subscribeToProducts` (`src/services/products.ts:97`), `subscribeToOrders` (`src/services/orders.ts:65`), `subscribeToCategories` (`src/services/categories.ts:46`) listen to `event: '*'` and, on **every** change, re-run the full `select *` of the whole table. One admin uploading a 5-image product fires 5+ INSERT events → 5 full catalog downloads to every connected client. No debounce, no delta application. On intermittent 3G this is a battery/data killer that worsens as the catalog grows.
- **Proposed solution:** Apply the event payload directly (`payload.new` / merge out `payload.old`) for INSERT/UPDATE/DELETE, or debounce-refetch (e.g. 500ms trailing). Keep a full refetch only as a fallback on error.
- **Impact:** removes a self-inflicted DDoS on mobile data; subscriptions become near-free. **Effort M / Impact H**

### B3 — Cart was not persisted ✅
- **Problem:** `AppContext.tsx` hydrated products/orders/categories only; the cart died on every app restart and every WebView reload — silently, on the flakiest connections.
- **Fix applied:** `CACHE_KEYS.cart = '@schoolshop_cart'` with `loadCartFromCache`/`saveCartToCache` in `src/services/cache.ts`; hydrate cart in the startup `Promise.all`; new `SET_CART` action; write-through effect persisting `state.cart` after hydration. Note: cart lines embed full `Product` objects (denormalized) — acceptable for MVP, but see M3.
- **Impact:** cart abandonment from lost carts disappears; also the foundation for TMA persistence (AsyncStorage maps to WebView localStorage). **Effort L / Impact H**

### B4 — Supabase auth not persisted on native ⬜
- **Problem:** `src/lib/supabase.ts` creates the client with no `auth.storage` option, so on React Native there is no persistent session store. Admin sessions die on every cold start despite the restore logic in `AppContext.tsx:238-255`.
- **Proposed solution:** Pass a small storage adapter backed by `@react-native-async-storage/async-storage` (`getItem`/`setItem`/`removeItem`) to `createClient({ auth: { storage } })`. Works on web/TMA unchanged.
- **Impact:** admins stop being logged out daily; fewer failed upload sessions. **Effort M / Impact M**

### B5 — Shoppers download ALL orders ever placed ⬜
- **Problem:** `fetchOrders` (`src/services/orders.ts:50`) does `.select('*')` with no pagination or role gating, and `AppContext` calls it for every shopper at startup. Payload grows monotonically and carries customer phone numbers (PII) to every device.
- **Proposed solution:** Gate order fetching to admins (`role !== 'user'`), and for shoppers fetch orders only by their phone number once an order is placed (MVP: skip shopper order history entirely and rely on admin confirmation via phone/Telegram). Add `range()` pagination for admin order lists.
- **Impact:** startup payload shrinks from "all history" to "catalog only"; closes a PII exposure vector. **Effort M / Impact H**

### B6 — Prices rendered in USD ✅
- **Problem:** `$${price.toFixed(2)}` was hard-coded in 6+ screens plus the order-summary image and share message — US dollars in an Ethiopian student shop is an instant trust-killer.
- **Fix applied:** `formatPrice()` in `src/utils/format.ts` (`Intl.NumberFormat`, no cents — ETB is not decimal-priced) rendering e.g. `1,250 ETB`; swept every occurrence (cards, detail, cart, checkout, orders, order detail, admin screens, `utils/share.ts`, `utils/summaryImage.ts`). Convention documented in AGENTS.md.
- **Impact:** prices are immediately interpretable and comparable; removes a "foreign/template shop" signal at checkout. **Effort L / Impact H**

---

## Quick Wins (implemented)

### QW1 — Touch targets on primary commerce actions ✅
- **Problem:** add-to-cart button 28×28 (`ProductCard.tsx`), qty steppers 26–28px (`ProductCard.tsx`, `CartItemRow.tsx`), category chips 24px tall with 2px gaps (`CategoryFilter.tsx`) — the most-tapped elements in the app were ~⅓ the 44px accessibility guideline. Mis-taps on a laggy 3G Android read as "the app is broken".
- **Fix:** buttons/steppers enlarged to 40–44px hit areas (glyph stays visually smaller inside); chips 24→36px tall, gaps kept scrollable.
- **Impact:** fewer mis-taps on the money path (grid → cart → checkout). **Effort L / Impact H**

### QW2 — Font floor on phones ✅
- **Problem:** compact-mode text hit 12px (category chips, search input) and badge text 9px — hard to read on mid-range Android screens in sunlight.
- **Fix:** chip/search compact font 12→14px; badge text 9→10px. Changes confined to compact branches; desktop untouched.
- **Impact:** readability for the entire audience at zero layout cost. **Effort L / Impact M**

### QW3 — Checkout friction & trust ✅
- **Problem:** `CheckoutScreen.tsx` had the Place Order button inline below the card form (scrolled out of reach on phones), no delivery fee/estimate, no COD reassurance, no return/contact info, a hard-coded `#F0F7FF` selected-background that breaks dark mode, and each cart line became a *separate* Order so a 3-item checkout announced "Your 3 orders have been placed".
- **Fix:**
  - Sticky bottom bar, always thumb-reachable:
    ```
    ┌────────────────────────────────────┐
    │  3 items          [  Place Order  ] │
    │  ETB 1,850                         │  ← sticky footer, all screens
    └────────────────────────────────────┘
    ```
  - Summary now shows `Delivery (Addis Ababa) — FREE` + `Estimated delivery: 1–3 days`.
  - COD option subtext: "Pay when your order arrives. Inspect before you pay." — directly addresses the #1 COD anxiety (paying for something unseen).
  - Trust block: 7-day return note + "call or message us on Telegram" support row.
  - Telebirr shown as a disabled "Coming soon" option — signals mobile-money alignment without faking an integration.
  - Online payment labeled "Demo — no real charge is made" so the card form stops feeling like a scam.
  - Selected-option background now theme-derived (`colors.primary + '14'`), dark-mode safe.
  - Checkout now creates **one** `Order` with all cart lines; success message singular. `OrdersScreen` already joins item names, so history reads naturally.
- **Impact:** shorter perceived checkout, COD trust copy at the decision point, no more confusing multi-order history. Expect measurably fewer drop-offs between cart and placed order. **Effort M / Impact H**

### QW4 — Dependency & config cleanup ✅
- **Problem:** `expo-dev-client` sat in runtime dependencies; `react-native-view-shot` was installed but unused anywhere in `src`; `EXPO_PUBLIC_ADMIN_EMAIL/PASSWORD` in `.env.example` would inline admin credentials into the client JS bundle if anyone set them (Metro inlines every `EXPO_PUBLIC_*` var).
- **Fix:** `expo-dev-client` moved to devDependencies; `react-native-view-shot` removed (lockfile synced); env vars renamed to `SUPABASE_ADMIN_EMAIL`/`SUPABASE_ADMIN_PASSWORD` in `.env.example` and `scripts/setup-admin.js`; dead `src/constants/admin.ts` deleted; AGENTS.md updated. **⚠️ Update your local `.env` to the new variable names.**
- **Impact:** smaller install/bundle surface; eliminates a credential-leak footgun. **Effort L / Impact M**

### QW5 — Small correctness fixes ✅
- `AppContext.deleteProduct`: storage image cleanup now runs *after* a successful DB delete (previously ran before, so a failed DB delete left images already gone for a product that still exists). Cleanup stays best-effort (`.catch(() => {})`).
- Tab bar cart badge caps at `99+` instead of growing unbounded (`UserTabNavigator.tsx`).
- AGENTS.md corrected: real cache keys (`@schoolshop_*`), single-order checkout, `CartItem` shape, stale "footer on home screen" claim removed.

---

## Medium priority (schedule next)

| # | Finding | Where | Proposal | Effort / Impact |
|---|---------|-------|----------|-----------------|
| M1 | No landmark/campus location picker — free-text only, no validation | `CheckoutScreen.tsx:147-153` | Picker of common landmarks (university campuses, dorms, gates) + free-text fallback; validate non-placeholder | M / H |
| M2 | No discount/compare-at/bundle support in data model | `src/types/index.ts:13-23` | Add `compareAtPrice?: number` to `Product`; render strikethrough + % badge on `ProductCard`/`ProductDetailScreen`; admin field in `AddEditItemScreen` | M / H |
| M3 | Cart lines embed full `Product` (images array) — stale prices, cache bloat | `src/types/index.ts:25-29`, `AppContext.tsx` | Store `{productId, quantity, selectedImageIndex}` and re-derive from `products`; merge on hydrate for resilience to deleted products | M / M |
| M4 | No image placeholder/spinner per image; blank cells on slow 3G | all `<Image>` usages | Part of B1 (`expo-image` `placeholder`/`transition`) — can ship independently | L / M |
| M5 | Generic visual identity — iOS system blue + Bootstrap palette | `src/constants/theme.ts:3-33` | Derive a brand palette from `assets/logo.png` (vibrant-but-professional; green/gold/yellow family resonates locally); keep token structure | M / M |
| M6 | Orders list renders core `<Image>` and re-fetches full products; startup ~5 network requests + 3 WebSocket handshakes unconditionally | `AppContext.tsx:216-282` | Lazy-init non-critical fetches; defer orders to admin role only (see B5) | M / M |
| M7 | `placehold.co` external dependency for every placeholder image | `src/utils/images.ts:6-9` | Generate a local colored placeholder (solid color + initial) so the grid never depends on the network | L / M |
| M8 | Optimistic-update rollback snapshots capture render-closure state; rapid successive mutations can roll back a later success | `AppContext.tsx:347-448` | Snapshot inside the reducer or via functional updates; preserve original Supabase error on rollback | M / L |
| M9 | Corrupted cache JSON silently yields empty catalog | `src/services/cache.ts:9-16` | Log + treat parse failure as `null` with a console.warn; consider cache versioning | L / L |

---

## Telegram Mini App migration readiness

No TMA-specific features were implemented (per scope). Structural notes:

1. **Platform gates all flip to "web" inside a TMA WebView** — ~30 `Platform.OS === 'web'` checks across 19 files. Mostly good (responsive grids, WebHeader), but the web bottom tab bar is **hidden** (`UserTabNavigator.tsx:23`), so Cart/Orders have no navigation chrome unless every screen renders a web header. Before migrating, add header chrome (or a bottom bar) for all shopper screens on web.
2. **No `linking` config** on `NavigationContainer` (`AppNavigator.tsx:19`) — no deep links today. Add when you want shareable product/order links; also needed to cooperate with Telegram's native BackButton semantics (`history.back()` / close Mini App).
3. **Admin-only native modules won't exist in a TMA** — `expo-image-picker`, `expo-image-manipulator`, `@react-native-picker/picker`, `expo-file-system` are statically imported by admin screens/utils and land in the bundle. Plan code-splitting (dynamic imports behind role checks) or replace with Telegram attachment APIs. Shopper flows are unaffected.
4. **Cart persistence (QW3/B3 fix) is TMA-ready** — AsyncStorage maps cleanly to WebView localStorage; the cart now survives the Mini App being closed and reopened.
5. **Supabase client** works in a WebView as-is (falls back to localStorage for auth) — but see B4 for making native consistent; do both at once.
6. **Viewport/safe-area**: `Screen` uses safe-area-context which maps to CSS `env(safe-area-inset-*)` on web — correct for notched phones in a WebView; verify the always-on `bottom` edge against your in-TMA navigation once built.
7. **`react-native-share`** is native-only and already dynamically imported — the web path uses `navigator.share`; inside Telegram, prefer sharing via `t.me` links or the Bot API instead.

---

## Suggested order for the next pass

1. B1 (image cache + variants) + M4/M7 — one image-focused pass.
2. B2 (realtime deltas/debounce) — small, high leverage.
3. B5 + M6 (role-gated orders, fewer startup requests).
4. B4 (auth storage) + env follow-through.
5. M2 + M1 (price-sensitivity UX: compare-at prices, landmark picker) — conversion-focused.
6. M5 (brand palette) — pair with M2 badge colors.
