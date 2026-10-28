export type Category = string;

export type Role = 'user' | 'admin' | 'super_admin';

export type AdminRole = 'admin' | 'super_admin';

export type Theme = 'light' | 'dark';

export type PaymentMethod = 'bank_transfer';

/** One of a tenant's bank transfer accounts (profiles.bank_accounts, migration 031). */
export interface BankAccount {
  accountNumber: string;
  /** Optional label so shoppers can tell accounts apart (e.g. CBE, Awash). */
  bankName?: string;
  qrImageUrl?: string;
}

/** One selectable choice inside a variant group (migration 035). */
export interface VariantOption {
  name: string;
  /** Set only on options of the price group — it replaces the base price. */
  price?: number;
  /** Optional: index into product.images shown when this option is picked. */
  imageIndex?: number;
}

/** A named set of choices for a product ("Size", "Color"). Exactly one group
 *  per product may set the price (affectsPrice). */
export interface VariantGroup {
  name: string;
  affectsPrice: boolean;
  options: VariantOption[];
}

export type OrderStatus = 'pending' | 'paid' | 'on_the_way' | 'completed';

/** A tenant-defined question the buyer answers at checkout (migration 036).
 *  type 'text' = free text input; type 'dropdown' = pick one of `options`. */
export interface CheckoutField {
  label: string;
  type: 'text' | 'dropdown';
  required: boolean;
  /** dropdown only: the choices the buyer picks from. */
  options?: string[];
}

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  category: Category;
  images: string[];
  /** Optional detail images (size charts, close-ups) shown under the description (migration 027). */
  detailImages?: string[];
  /** "Price on request": no price tag, no add-to-cart — shoppers order via chat (migration 029). */
  priceHidden?: boolean;
  /** Units ordered so far; server-maintained by trigger, powers the Popular sort (migration 030). */
  orderCount?: number;
  coverImageIndex: number;
  createdAt: string;
  ownerId?: string;
  /** Tenant shop name, resolved from the owner's profile (profiles.shop_name). */
  shopName?: string;
  /** Tenant bank transfer accounts, resolved from the owner's profile (migration 031). */
  ownerBankAccounts?: BankAccount[];
  /** Flat shipping fee the shop charges once per order (migration 031); undefined/0 = free. */
  ownerShippingFee?: number;
  /** Tenant shop logo, resolved from the owner's profile (migration 023). */
  ownerShopLogoUrl?: string;
  /** Tenant shop description, resolved from the owner's profile (migration 024). */
  ownerShopDescription?: string;
  /** Tenant Telegram username for shopper chat, resolved from the owner's profile (migration 025). */
  ownerTelegramUsername?: string;
  /** Whether this shop requires pre-order payment verification (migration 043); undefined = on. */
  ownerPaymentVerificationEnabled?: boolean;
  /** Optional variant groups ("Size", "Color"); one group may set the price (migration 035). */
  variantGroups?: VariantGroup[];
  /** Tenant-defined questions the buyer answers at checkout (migration 036). */
  checkoutFields?: CheckoutField[];
}

/** A downloadable PDF attached to a product post (migration 044). Files on
 *  price-0 posts are publicly listed (free downloads); files on priced posts
 *  are hidden from anonymous clients and unlock for the buyer once the order
 *  item is marked paid (via the sign-book-get edge function action). */
export interface ProductFile {
  id: string;
  productId: string;
  /** Display name shown on download buttons, e.g. "Mathematics Grade 1". */
  name: string;
  /** R2 object key (books/<name>.pdf) in the public bucket. */
  key: string;
  /** Public URL derived from the key. */
  url: string;
  sizeBytes?: number;
}

export interface CartItem {
  product: Product;
  quantity: number;
  selectedImageIndex: number;
  /** Chosen variant options (absent/empty = product has no variants or none picked). */
  selectedOptions?: { group: string; option: string }[];
  /** Unit price snapshotted at add-to-cart time (variant price); absent = product.price. */
  unitPrice?: number;
  /** Buyer's answers to the product's checkout questions, snapshotted on the
   *  order item (absent/empty = product has no questions or none answered). */
  fieldAnswers?: { label: string; value: string }[];
}

export interface Order {
  id: string;
  items: CartItem[];
  total: number;
  paymentMethod: PaymentMethod;
  status: OrderStatus;
  location: string;
  phoneNumber: string;
  /** Shopper's student name. Collected at checkout by migration 034; no longer
   *  a fixed field since 036 — kept for legacy orders only. */
  studentName?: string;
  createdAt: string;
  /** Set for orders placed from a Telegram Mini App session. */
  telegramId?: number;
  /** Ids of the tenant admins whose products are in this order (migration 018). */
  tenantIds?: string[];
  /** Payment proof photo URLs uploaded at checkout, keyed by tenant owner id (migration 020). */
  paymentProofs?: Record<string, string>;
  /** Per-shop payment references verified at checkout via the
   *  verify-payment-reference function, keyed by tenant owner id (migration 041).
   *  The key is replayed post-order so verify.et does not bill the retry. */
  paymentReferences?: Record<string, { provider: 'cbe' | 'telebirr'; reference: string; key: string }>;
  /** Flat shipping fees charged per shop at checkout, keyed by tenant owner id (migration 031). */
  shippingFees?: Record<string, number>;
  /** Per-item statuses, keyed by "productId:selectedImageIndex" (migration 022).
   *  Items without an entry fall back to the order-level `status`. */
  itemStatuses?: Record<string, string>;
}

/** A shopper identified via a validated Telegram Mini App session. */
export interface Shopper {
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

/** verify.et verification of one merchant's payment proof (migration 040).
 *  One current attempt per (order, tenant); `checks` keys mirror the edge
 *  function: paymentComplete, recipientMatch, amountMatch,
 *  notPreviouslyClaimed, receiptOwnership, plus error/manualApproval. */
export type VerificationStatus = 'pending' | 'verified' | 'needs_review' | 'failed' | 'error';

export interface VerificationCheck {
  result: 'pass' | 'review' | 'fail';
  reason: string;
}

export interface PaymentVerification {
  id: string;
  orderId: string;
  tenantId: string;
  attemptNo: number;
  status: VerificationStatus;
  checks: Record<string, VerificationCheck>;
  expectedAmount: number | null;
  paidAmount: number | null;
  provider: string | null;
  reference: string | null;
  receiverAccount: string | null;
  payer: string | null;
  transactionDate: string | null;
  updatedAt: string;
}

export interface AppState {
  role: Role;
  theme: Theme;
  products: Product[];
  cart: CartItem[];
  orders: Order[];
  categories: Category[];
}

export type AppAction =
  | { type: 'SET_ROLE'; payload: Role }
  | { type: 'SET_THEME'; payload: Theme }
  | { type: 'SET_PRODUCTS'; payload: Product[] }
  | { type: 'ADD_PRODUCT'; payload: Product }
  | { type: 'UPDATE_PRODUCT'; payload: Product }
  | { type: 'DELETE_PRODUCT'; payload: string }
  | { type: 'ADD_TO_CART'; payload: { product: Product; selectedImageIndex: number; variantKey?: string; selectedOptions?: CartItem['selectedOptions']; unitPrice?: number } }
  | { type: 'SET_CART'; payload: CartItem[] }
  | { type: 'REMOVE_FROM_CART'; payload: { productId: string; selectedImageIndex: number; variantKey?: string } }
  | { type: 'UPDATE_CART_QUANTITY'; payload: { productId: string; selectedImageIndex: number; variantKey?: string; quantity: number } }
  | { type: 'CLEAR_CART' }
  | { type: 'SET_ORDERS'; payload: Order[] }
  | { type: 'ADD_ORDER'; payload: Order }
  | { type: 'UPDATE_ORDER'; payload: Order }
  | { type: 'DELETE_ORDER'; payload: string }
  | { type: 'SET_CATEGORIES'; payload: Category[] }
  | { type: 'ADD_CATEGORY'; payload: Category }
  | { type: 'REMOVE_CATEGORY'; payload: Category };
