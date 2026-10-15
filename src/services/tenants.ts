import { createClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { BankAccount } from '../types';

export interface Tenant {
  id: string;
  code: string | null;
  username: string | null;
  email: string | null;
  shopName: string | null;
  telegramChatId: string | null;
  bankAccounts: BankAccount[];
  /** Flat shipping fee per order; null = free delivery (migration 031). */
  shippingFee: number | null;
  shopLogoUrl: string | null;
  shopDescription: string | null;
  telegramUsername: string | null;
  /** false = super admin switched the shop off: catalog hides its products
   *  and the tenant is locked out (migration 037). */
  isActive: boolean;
  role: 'admin';
  createdAt: string;
}

interface DbBankAccount {
  account_number?: string | null;
  bank_name?: string | null;
  qr_image_url?: string | null;
}

function toBankAccounts(db: unknown): BankAccount[] {
  if (!Array.isArray(db)) return [];
  return db
    .map((entry): BankAccount | null => {
      const raw = entry as DbBankAccount;
      if (!raw?.account_number) return null;
      return {
        accountNumber: raw.account_number,
        bankName: raw.bank_name ?? undefined,
        qrImageUrl: raw.qr_image_url ?? undefined,
      };
    })
    .filter((a): a is BankAccount => a !== null);
}

interface DbProfile {
  id: string;
  tenant_code: string | null;
  username: string | null;
  email: string | null;
  shop_name: string | null;
  telegram_chat_id: string | null;
  bank_accounts: unknown;
  shipping_fee: number | null;
  shop_logo_url: string | null;
  shop_description: string | null;
  telegram_username: string | null;
  is_active: boolean;
  role: 'admin';
  created_at: string;
}

const TENANT_SELECT =
  'id, tenant_code, username, email, shop_name, telegram_chat_id, bank_accounts, shipping_fee, shop_logo_url, shop_description, telegram_username, is_active, role, created_at';

function toTenant(db: DbProfile): Tenant {
  return {
    id: db.id,
    code: db.tenant_code,
    username: db.username,
    email: db.email,
    shopName: db.shop_name,
    telegramChatId: db.telegram_chat_id,
    bankAccounts: toBankAccounts(db.bank_accounts),
    shippingFee: db.shipping_fee ?? null,
    shopLogoUrl: db.shop_logo_url,
    shopDescription: db.shop_description,
    telegramUsername: db.telegram_username,
    isActive: db.is_active,
    role: db.role,
    createdAt: db.created_at,
  };
}

const TENANT_EMAIL_DOMAIN = 'tenant.schoolshop.app';

function getTenantEmail(username: string): string {
  return `${username.toLowerCase()}@${TENANT_EMAIL_DOMAIN}`;
}

// A secondary, in-memory client is used for tenant signUp so the super admin's
// active session is not replaced by the newly created tenant session.
function createSignupClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase environment variables. ' +
        'Make sure EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY are set.'
    );
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function fetchTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select(TENANT_SELECT)
    .eq('role', 'admin')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toTenant);
}

export async function fetchTenantById(id: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select(TENANT_SELECT)
    .eq('id', id)
    .eq('role', 'admin')
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data ? toTenant(data) : null;
}

export async function deleteTenant(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_tenant_user', {
    tenant_id: id,
  });
  if (error) throw error;
}

/** Super admin switches a shop off/on (profiles.is_active, migration 037).
 *  Off = products hidden from the catalog and the tenant locked out. */
export async function adminSetTenantActive(
  id: string,
  isActive: boolean
): Promise<void> {
  const { error } = await supabase.rpc('admin_set_tenant_active', {
    tenant_id: id,
    new_is_active: isActive,
  });
  if (error) throw new Error(error.message || 'Failed to update shop status.');
}

/** Super admin edits a tenant's username (gateway), email, and shop name. */
export async function adminUpdateTenant(
  id: string,
  username: string,
  email: string,
  shopName: string
): Promise<void> {
  const cleanUsername = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();
  const cleanShopName = shopName.trim();

  if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
    throw new Error('Username must be 3–20 characters: letters, numbers, underscores.');
  }
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email.');
  }
  if (!cleanShopName) {
    throw new Error('Shop name is required.');
  }

  const { error } = await supabase.rpc('admin_update_tenant', {
    tenant_id: id,
    new_username: cleanUsername,
    new_email: cleanEmail,
    new_shop_name: cleanShopName,
  });
  if (error) {
    if (error.code === '23505') {
      throw new Error(`Username "${cleanUsername}" is already taken.`);
    }
    throw new Error(error.message || 'Failed to update tenant.');
  }
}

/** Super admin sets a tenant's password (empty string = leave unchanged). */
export async function adminSetTenantPassword(
  id: string,
  newPassword: string
): Promise<void> {
  if (newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const { error } = await supabase.rpc('admin_set_tenant_password', {
    tenant_id: id,
    new_password: newPassword,
  });
  if (error) throw new Error(error.message || 'Failed to set password.');
}

export async function createTenant(
  username: string,
  password: string,
  shopName: string,
  email?: string,
  telegramChatId?: string,
  bankAccounts?: BankAccount[],
  shippingFee?: number | null,
  shopLogoUrl?: string,
  shopDescription?: string,
  telegramUsername?: string
): Promise<Tenant> {
  const cleanUsername = username.trim().toLowerCase();
  const cleanShopName = shopName.trim();
  // The super admin may give a custom email; otherwise derive one from the
  // username so the account works with Supabase Auth regardless.
  const customEmail = email?.trim().toLowerCase();
  const finalEmail = customEmail || getTenantEmail(cleanUsername);
  const cleanBankAccounts = (bankAccounts ?? []).filter((a) => a.accountNumber.trim());
  const cleanLogoUrl = shopLogoUrl?.trim() ?? '';
  const cleanDescription = shopDescription?.trim() ?? '';
  const cleanTelegramUsername = telegramUsername?.trim().replace(/^@/, '') ?? '';
  const cleanShippingFee = shippingFee && shippingFee > 0 ? shippingFee : null;

  if (!cleanUsername) {
    throw new Error('Username is required.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  if (!cleanShopName) {
    throw new Error('Shop name is required.');
  }
  if (!cleanLogoUrl) {
    throw new Error('Shop logo is required.');
  }
  if (customEmail && !customEmail.includes('@')) {
    throw new Error('Please enter a valid email.');
  }

  const signupClient = createSignupClient();

  const { data, error } = await signupClient.auth.signUp({
    email: finalEmail,
    password,
    options: {
      data: { username: cleanUsername, shop_name: cleanShopName },
    },
  });

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes('already registered') || message.includes('already exists')) {
      throw new Error(`Username or email is already taken.`);
    }
    throw new Error(error.message || 'Failed to create tenant');
  }

  if (!data.user) {
    throw new Error('Failed to create tenant. No user was returned.');
  }

  // The profile row is created synchronously by the on_auth_user_created
  // trigger, so it can be updated right away. Allowed for the super admin by
  // the "Allow super admin update profiles" policy.
  const cleanChatId = telegramChatId?.trim() ?? '';
  if (
    cleanChatId ||
    cleanBankAccounts.length > 0 ||
    cleanShippingFee != null ||
    cleanLogoUrl ||
    cleanDescription ||
    cleanTelegramUsername
  ) {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        telegram_chat_id: cleanChatId || null,
        bank_accounts: cleanBankAccounts.map((a) => ({
          account_number: a.accountNumber.trim(),
          bank_name: a.bankName?.trim() || null,
          qr_image_url: a.qrImageUrl?.trim() || null,
        })),
        shipping_fee: cleanShippingFee,
        shop_logo_url: cleanLogoUrl || null,
        shop_description: cleanDescription || null,
        telegram_username: cleanTelegramUsername || null,
      })
      .eq('id', data.user.id);
    if (profileError) {
      // The account now exists, so report instead of silently dropping the
      // shop details — the super admin can set them later from Tenant
      // Management (tenant detail → Edit Account).
      throw new Error(
        `Tenant @${cleanUsername} was created, but saving the shop details failed: ${profileError.message}. ` +
          'Open the tenant in Tenant Management and set them there.'
      );
    }
  }

  return {
    id: data.user.id,
    code: null, // Assigned by the database trigger; refetch to display it.
    username: cleanUsername,
    email: finalEmail,
    shopName: cleanShopName,
    telegramChatId: cleanChatId || null,
    bankAccounts: cleanBankAccounts,
    shippingFee: cleanShippingFee,
    shopLogoUrl: cleanLogoUrl || null,
    shopDescription: cleanDescription || null,
    telegramUsername: cleanTelegramUsername || null,
    isActive: true,
    role: 'admin',
    createdAt: new Date().toISOString(),
  };
}

/** Super admin sets a tenant's bank transfer accounts
 *  (profiles.bank_accounts, migration 031). Entries without an account
 *  number are dropped. */
export async function adminSetTenantBankAccounts(
  id: string,
  bankAccounts: BankAccount[]
): Promise<void> {
  const clean = bankAccounts
    .filter((a) => a.accountNumber.trim())
    .map((a) => ({
      account_number: a.accountNumber.trim(),
      bank_name: a.bankName?.trim() || null,
      qr_image_url: a.qrImageUrl?.trim() || null,
    }));
  const { error } = await supabase
    .from('profiles')
    .update({ bank_accounts: clean })
    .eq('id', id);
  if (error) throw new Error(error.message || 'Failed to update bank accounts.');
}

/** Super admin sets a tenant's flat shipping fee per order
 *  (profiles.shipping_fee, migration 031). 0/empty = free delivery. */
export async function adminSetTenantShippingFee(
  id: string,
  shippingFee: number | null
): Promise<void> {
  const clean = shippingFee && shippingFee > 0 ? shippingFee : null;
  const { error } = await supabase
    .from('profiles')
    .update({ shipping_fee: clean })
    .eq('id', id);
  if (error) throw new Error(error.message || 'Failed to update shipping fee.');
}

/** Super admin sets/clears the Telegram group chat id that order
 *  notifications for this tenant's products are routed to
 *  (profiles.telegram_chat_id, migration 018). Empty string clears it. */
export async function adminSetTenantTelegramChat(
  id: string,
  telegramChatId: string
): Promise<void> {
  const cleanChatId = telegramChatId.trim();
  const { error } = await supabase
    .from('profiles')
    .update({ telegram_chat_id: cleanChatId || null })
    .eq('id', id);
  if (error) throw new Error(error.message || 'Failed to update Telegram chat ID.');
}

/** Super admin sets a tenant's shop logo (profiles.shop_logo_url, migration
 *  023). Only the super admin may change it — tenants edit their own bank
 *  details and description but never their logo. */
export async function adminSetTenantShopLogo(
  id: string,
  shopLogoUrl: string
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ shop_logo_url: shopLogoUrl.trim() || null })
    .eq('id', id);
  if (error) throw new Error(error.message || 'Failed to update shop logo.');
}

/** Super admin sets a tenant's shop description
 *  (profiles.shop_description, migration 024). Empty string clears it. The
 *  tenant can also edit their own description via update_own_shop_description. */
export async function adminSetTenantShopDescription(
  id: string,
  shopDescription: string
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ shop_description: shopDescription.trim() || null })
    .eq('id', id);
  if (error) throw new Error(error.message || 'Failed to update shop description.');
}

/** Super admin sets a tenant's public Telegram username
 *  (profiles.telegram_username, migration 025). Empty string clears it. The
 *  tenant can also edit their own via update_own_telegram_username. Stored
 *  without the leading "@". */
export async function adminSetTenantTelegramUsername(
  id: string,
  telegramUsername: string
): Promise<void> {
  const clean = telegramUsername.trim().replace(/^@/, '');
  const { error } = await supabase
    .from('profiles')
    .update({ telegram_username: clean || null })
    .eq('id', id);
  if (error) throw new Error(error.message || 'Failed to update Telegram username.');
}
