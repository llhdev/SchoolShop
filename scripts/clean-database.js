// Clean-database script: wipes the platform down to a fresh start with only
// the super admin account.
//
// Usage (credentials come from env vars, never hardcode them in the repo):
//   CLEAN_USERNAME=<super-admin-username> CLEAN_PASSWORD=<password> node scripts/clean-database.js
//
// What it removes: every tenant account (auth user + profile + their products,
// via the app's own delete_tenant_user RPC), all remaining products, orders,
// categories, Telegram shoppers, and all objects in the product-images,
// payment-proofs, bank-qrs and shop-logos storage buckets.
// What it keeps: exactly one account — the super admin identified by
// CLEAN_USERNAME. The script aborts before deleting anything if it cannot
// confirm that account.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const username = process.env.CLEAN_USERNAME;
const password = process.env.CLEAN_PASSWORD;

if (!url || !anonKey) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}
if (!username || !password) {
  console.error('Missing CLEAN_USERNAME or CLEAN_PASSWORD env vars.');
  process.exit(1);
}

const supabase = createClient(url, anonKey);

const BUCKETS = ['product-images', 'payment-proofs', 'bank-qrs', 'shop-logos'];

function fail(message, err) {
  console.error(`\nAborted: ${message}`);
  if (err) console.error(err.message || err);
  process.exit(1);
}

async function countRows(table) {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) fail(`Could not count rows in ${table}.`, error);
  return count ?? 0;
}

async function emptyBucket(bucket) {
  let removed = 0;
  for (;;) {
    const { data: objects, error } = await supabase.storage
      .from(bucket)
      .list('', { limit: 100, offset: 0 });
    if (error) fail(`Could not list objects in bucket ${bucket}.`, error);
    if (!objects || objects.length === 0) break;
    const paths = objects.map((o) => o.name).filter(Boolean);
    if (paths.length === 0) break;
    const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
    if (removeError) fail(`Could not remove objects from bucket ${bucket}.`, removeError);
    removed += paths.length;
  }
  return removed;
}

async function main() {
  console.log(`Clean start: keeping only super admin "${username}".\n`);

  // 1. Resolve the super admin's email + role by username (public lookup RPC).
  const { data: lookup, error: lookupError } = await supabase.rpc('get_admin_by_username', {
    username,
  });
  if (lookupError) fail('get_admin_by_username RPC failed.', lookupError);
  const admin = Array.isArray(lookup) ? lookup[0] : lookup;
  if (!admin || !admin.email) fail(`No admin found with username "${username}".`);
  if (admin.role !== 'super_admin') {
    fail(`Username "${username}" is a ${admin.role}, not the super admin. Refusing to continue.`);
  }
  console.log(`Super admin resolved: ${admin.email}`);

  // 2. Sign in as the super admin. Their JWT passes every guard we rely on.
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: admin.email,
    password,
  });
  if (signInError) {
    fail(
      'Sign-in failed — the password does not match this account. Nothing was deleted.',
      signInError
    );
  }
  console.log('Signed in as super admin.');

  // 3. Snapshot profiles so we can verify the outcome and never touch the admin.
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, role, username');
  if (profilesError) fail('Could not read profiles.', profilesError);
  const superAdmin = profiles.find((p) => p.username === username && p.role === 'super_admin');
  if (!superAdmin) fail('Could not confirm the super admin profile. Refusing to continue.');
  const others = profiles.filter((p) => p.id !== superAdmin.id);
  console.log(`Found ${others.length} non-super-admin account(s) to remove.`);

  // 4. Delete every other account through the app's own RPC
  //    (removes their products, then their auth user; profile cascades).
  for (const profile of others) {
    const { error: rpcError } = await supabase.rpc('delete_tenant_user', {
      tenant_id: profile.id,
    });
    if (rpcError) fail(`Failed to delete account ${profile.username ?? profile.id}.`, rpcError);
    console.log(`Deleted account: ${profile.username ?? profile.id} (${profile.role})`);
  }

  // 5. Wipe the remaining tables (per-table PK for the "match all" filter).
  const tableKeys = { products: 'id', orders: 'id', categories: 'name', shoppers: 'telegram_id' };
  for (const [table, key] of Object.entries(tableKeys)) {
    const { error } = await supabase.from(table).delete().neq(key, key === 'telegram_id' ? 0 : '');
    if (error) fail(`Failed to clear ${table}.`, error);
  }
  console.log('Cleared products, orders, categories, shoppers.');

  // 6. Empty the storage buckets.
  let objectsRemoved = 0;
  for (const bucket of BUCKETS) {
    objectsRemoved += await emptyBucket(bucket);
  }
  console.log(`Removed ${objectsRemoved} storage object(s) from ${BUCKETS.length} buckets.`);

  // 7. Verify the end state.
  const { data: finalProfiles, error: finalError } = await supabase
    .from('profiles')
    .select('id, role, username');
  if (finalError) fail('Could not re-read profiles for verification.', finalError);
  if (finalProfiles.length !== 1 || finalProfiles[0].id !== superAdmin.id) {
    fail('Post-clean verification failed: profiles table does not contain exactly the super admin.');
  }
  const remaining = {
    products: await countRows('products'),
    orders: await countRows('orders'),
    categories: await countRows('categories'),
    shoppers: await countRows('shoppers'),
  };
  const leftover = Object.entries(remaining).filter(([, n]) => n > 0);
  if (leftover.length > 0) {
    fail(`Post-clean verification failed: non-empty tables -> ${JSON.stringify(remaining)}`);
  }

  await supabase.auth.signOut();

  console.log('\nClean start complete.');
  console.log(`Kept: super admin "${username}" (${admin.email})`);
  console.log(`Deleted: ${others.length} account(s), all products/orders/categories/shoppers, ${objectsRemoved} storage object(s).`);
}

main().catch((err) => {
  console.error('\nClean failed:', err.message || err);
  process.exit(1);
});
