# OnlineShop

Cross-platform mobile and web app built with **Expo SDK 54** and **React Native** for student online shopping.

## Features

### Student
- Browse products in a responsive grid.
- Search products by name or description.
- Filter products by category.
- **New Arrivals** filter for recently uploaded items.
- Add items to cart, adjust quantities, and remove items.
- Checkout with delivery location and Ethiopian phone-number validation.
- Choose between **Cash on Delivery** and **Simulated Online Payment**.
- View order history and order details with item images.

### Admin
- Add, edit, and delete products.
- Upload multiple product images and choose the cover image displayed on the home page.
- Manage custom categories (add/remove).
- View orders grouped by customer phone number.
- Review all orders for a single customer.

## Tech stack

- **Framework**: Expo SDK `~54.0.36`
- **UI**: React Native `0.81.5`, react-native-web `^0.21.0`
- **React**: `19.1.0`
- **Language**: TypeScript `~5.9.2` (strict mode)
- **Navigation**: React Navigation v7
- **State**: React Context + `useReducer`
- **Persistence**: AsyncStorage (`@react-native-async-storage/async-storage`)
- **Icons**: `@expo/vector-icons` (Ionicons)

## Requirements

- Node.js `22+`
- npm `10+`
- Expo Go app on your physical device, or an Android/iOS emulator

## Get started

```bash
# Install dependencies
npm install

# Start the development server
npm start
```

### Windows quick start

Double-click **`start-app.bat`** in the project folder. It will open a terminal, start the Expo dev server, and display the QR code you can scan with the Expo Go app.

## Run on a specific platform

```bash
npm run android   # Android emulator or connected device
npm run ios       # iOS simulator (macOS only)
npm run web       # Web browser
```

## Type checking

```bash
npx tsc --noEmit
```

## Project structure

```
.
├── App.tsx                         # Root component: AppProvider + AppNavigator
├── index.ts                        # Registers the root component with Expo
├── app.json                        # Expo app manifest
├── package.json                    # Dependencies and npm scripts
├── tsconfig.json                   # TypeScript configuration
├── start-app.bat                   # Windows quick-start helper
├── assets/                         # App icons, splash, favicon
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
    │   └── WebHeader.tsx           # Web-only Gold Fashion header
    ├── constants/
    │   ├── categories.ts           # Default category list and colors
    │   └── theme.ts                # Colors, spacing, font sizes, border radius
    ├── context/
    │   └── AppContext.tsx          # Global state, reducer, actions, persistence
    ├── data/
    │   └── seedProducts.ts         # Default product catalog
    ├── hooks/
    │   └── useResponsive.ts        # useWindowDimensions-based breakpoint helper
    ├── navigation/
    │   ├── AppNavigator.tsx        # Root native-stack navigator
    │   ├── AdminStackNavigator.tsx # Admin screens stack
    │   └── UserTabNavigator.tsx    # Student bottom-tabs
    ├── screens/
    │   ├── RoleSelectScreen.tsx    # Landing role chooser
    │   ├── admin/
    │   │   ├── AdminDashboardScreen.tsx
    │   │   ├── AdminOrdersScreen.tsx
    │   │   ├── AdminUserOrdersScreen.tsx
    │   │   └── AddEditItemScreen.tsx
    │   └── user/
    │       ├── HomeScreen.tsx
    │       ├── ProductDetailScreen.tsx
    │       ├── CartScreen.tsx
    │       ├── CheckoutScreen.tsx
    │       ├── OrdersScreen.tsx
    │       └── OrderDetailScreen.tsx
    ├── types/
    │   ├── index.ts                # Domain types
    │   └── navigation.ts           # React Navigation param lists
    └── utils/
        ├── images.ts               # Placeholder images + cover/gallery helpers
        ├── storage.ts              # AsyncStorage read/write helpers
        └── validation.ts           # Ethiopian phone number validation
```

## Architecture notes

- All shared state lives in `src/context/AppContext.tsx` and is persisted to AsyncStorage.
- On first launch, seed products and default categories are loaded if none exist.
- Products support multiple images; `coverImageIndex` controls which image is shown in lists.
- Each cart line item becomes a separate `Order` entry sharing location and phone number.
- The web layout uses dedicated responsive headers (`WebHeader`, `AdminHeader`); native targets use the standard bottom tab navigator.

## Notes

- **No real authentication.** Role selection is purely client-side state and can be switched at any time.
- **No real payment processing.** Online payment is simulated; card details are never transmitted or stored securely.
- **Local storage only.** AsyncStorage data is stored unencrypted on the device. Do not store real payment data, passwords, or sensitive PII in this app.
