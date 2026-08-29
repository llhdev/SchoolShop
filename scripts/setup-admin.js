// Setup script: creates the admin user in Supabase Auth and marks the profile as admin.
//
// Usage:
//   1. Add SUPABASE_SERVICE_ROLE_KEY to your .env file (find it in Supabase → Project Settings → API).
//      Example: SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs...
//   2. Run: node scripts/setup-admin.js
//   3. Remove SUPABASE_SERVICE_ROLE_KEY from .env afterward.

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
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.EXPO_PUBLIC_ADMIN_EMAIL;
const password = process.env.EXPO_PUBLIC_ADMIN_PASSWORD;

if (!url || !serviceRoleKey) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

if (!email || !password) {
  console.error('Missing EXPO_PUBLIC_ADMIN_EMAIL or EXPO_PUBLIC_ADMIN_PASSWORD in .env');
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

async function findUserByEmail(targetEmail) {
  const { data, error } = await supabase.auth.admin.listUsers();
  if (error) {
    console.error('Failed to list users:', error.message);
    process.exit(1);
  }
  return data.users.find((u) => u.email === targetEmail);
}

async function main() {
  console.log(`Setting up admin user: ${email}`);

  let user = await findUserByEmail(email);

  if (user) {
    console.log('User already exists. Updating password and confirming email...');
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
    });
    if (updateError) {
      console.error('Failed to update user:', updateError.message);
      process.exit(1);
    }
    console.log('User updated.');
  } else {
    console.log('Creating new admin user...');
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: 'admin' },
    });
    if (createError) {
      console.error('Failed to create user:', createError.message);
      process.exit(1);
    }
    user = createData.user;
    console.log('User created.');
  }

  if (!user) {
    console.error('Could not resolve admin user.');
    process.exit(1);
  }

  const { error: upsertError } = await supabase
    .from('profiles')
    .upsert({ id: user.id, role: 'admin' }, { onConflict: 'id' });

  if (upsertError) {
    console.error('Failed to set admin role:', upsertError.message);
    process.exit(1);
  }

  console.log('Admin setup complete. You can now log in from the app.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
