const { createClient } = require('@supabase/supabase-js');

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing env vars');
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  console.log('Resetting Supabase data...\n');

  const { error: deleteOrdersError } = await supabase.from('orders').delete().neq('id', '');
  if (deleteOrdersError) throw deleteOrdersError;
  console.log('Deleted all orders.');

  const { error: deleteProductsError } = await supabase.from('products').delete().neq('id', '');
  if (deleteProductsError) throw deleteProductsError;
  console.log('Deleted all products.');

  const { error: deleteCategoriesError } = await supabase.from('categories').delete().neq('name', '');
  if (deleteCategoriesError) throw deleteCategoriesError;
  console.log('Deleted all categories.');

  console.log('\nReset complete.');
}

run().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
