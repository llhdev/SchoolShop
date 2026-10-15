import { supabase } from '../lib/supabase';
import { BankAccount } from '../types';

export interface OwnProfile {
  username: string | null;
  email: string | null;
  shopName: string | null;
  bankAccounts: BankAccount[];
  /** Flat shipping fee per order; null = free delivery (migration 031). */
  shippingFee: number | null;
  shopLogoUrl: string | null;
  shopDescription: string | null;
  telegramUsername: string | null;
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

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

/** The signed-in admin's own profile row (username / email / shop name). */
export async function fetchOwnProfile(): Promise<OwnProfile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('username, email, shop_name, bank_accounts, shipping_fee, shop_logo_url, shop_description, telegram_username')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    username: data.username,
    email: data.email,
    shopName: data.shop_name,
    bankAccounts: toBankAccounts(data.bank_accounts),
    shippingFee: data.shipping_fee ?? null,
    shopLogoUrl: data.shop_logo_url,
    shopDescription: data.shop_description,
    telegramUsername: data.telegram_username,
  };
}

/** Save the signed-in tenant admin's bank transfer accounts
 *  (profiles.bank_accounts, migration 031). Entries without an account
 *  number are dropped server-side. */
export async function updateOwnBankAccounts(accounts: BankAccount[]): Promise<void> {
  const { error } = await supabase.rpc('update_own_bank_accounts', {
    p_accounts: accounts,
  });
  if (error) throw new Error(error.message || 'Failed to save bank accounts.');
}

/** Save the signed-in tenant admin's flat shipping fee per order
 *  (profiles.shipping_fee, migration 031). 0/empty = free delivery. */
export async function updateOwnShippingFee(fee: number | null): Promise<void> {
  const { error } = await supabase.rpc('update_own_shipping_fee', {
    p_fee: fee,
  });
  if (error) throw new Error(error.message || 'Failed to save shipping fee.');
}

/** Save the signed-in tenant admin's own shop description
 *  (profiles.shop_description, migration 024). Empty string clears it. */
export async function updateOwnShopDescription(
  shopDescription: string
): Promise<void> {
  const { error } = await supabase.rpc('update_own_shop_description', {
    p_description: shopDescription,
  });
  if (error) throw new Error(error.message || 'Failed to save shop description.');
}

/** Save the signed-in tenant admin's own public Telegram username
 *  (profiles.telegram_username, migration 025). Empty string clears it.
 *  Stored without the leading "@". */
export async function updateOwnTelegramUsername(
  telegramUsername: string
): Promise<void> {
  const { error } = await supabase.rpc('update_own_telegram_username', {
    p_username: telegramUsername,
  });
  if (error) throw new Error(error.message || 'Failed to save Telegram username.');
}

/** Change the signed-in admin's own login username (gateway). */
export async function changeGateway(newUsername: string): Promise<void> {
  const clean = newUsername.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(clean)) {
    throw new Error('Gateway must be 3–20 characters: letters, numbers, underscores.');
  }

  const { data: taken } = await supabase.rpc('get_admin_by_username', {
    username: clean,
  });
  if (taken && taken.length > 0) {
    throw new Error(`Gateway "${clean}" is already taken.`);
  }

  const { error } = await supabase.rpc('change_own_username', {
    new_username: clean,
  });
  if (error) {
    if (error.code === '23505') {
      throw new Error(`Gateway "${clean}" is already taken.`);
    }
    throw new Error(error.message || 'Failed to change gateway.');
  }
}

/** Change the signed-in admin's password after verifying the current one. */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  if (newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email;
  if (!email) throw new Error('Could not determine your account email.');

  // Verify the current password before allowing the change. This signs in
  // the same user again, so the active session simply refreshes.
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (signInError) {
    throw new Error('Current password is incorrect.');
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message || 'Failed to change password.');
}
