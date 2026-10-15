// One-off live test for the verify.et payment verification pipeline (040).
// Copies a real legacy proof into the private bucket, inserts a mirrored test
// order (same tenant/items, so the expected amount matches the real receipt),
// and lets the DB trigger drive verify-order-payment.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(idx + 1).trim();
  }
}
loadEnv();

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TENANT = '81025cf5-1087-4acb-8f34-8c23708a122b';
const LEGACY_PROOF_URL =
  'https://mzdprnvazllhfaxteeyk.supabase.co/storage/v1/object/public/payment-proofs/1792000871058-kd7w19y.jpg';
const TEST_ORDER_ID = process.env.TEST_ORDER_ID || 'TEST-VFY1';
const TEST_PROOF_PATH = `test-vfy1-proof-${Date.now()}.jpg`;

async function setupProxy() {
  const reachable = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 7890, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  if (reachable) {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7890'));
    console.log('using proxy 127.0.0.1:7890');
  }
}

async function main() {
  await setupProxy();
  const key = serviceKey || anonKey;
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1. Copy the real proof into the private bucket.
  const imgRes = await fetch(LEGACY_PROOF_URL);
  if (!imgRes.ok) throw new Error(`proof download failed: ${imgRes.status}`);
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  console.log(`proof bytes: ${bytes.length}`);
  const { error: upError } = await supabase.storage
    .from('payment-proofs-private')
    .upload(TEST_PROOF_PATH, bytes, { contentType: 'image/jpeg', upsert: false });
  if (upError) throw upError;
  console.log('proof uploaded to private bucket');

  // 2. Insert the mirrored test order (fires trg_orders_verify_payment).
  await supabase.from('orders').delete().eq('id', TEST_ORDER_ID);
  const items = [
    {
      product: {
        id: '1791447018274',
        name: 'Fairway Communication Book',
        price: 350,
        owner_id: TENANT,
      },
      quantity: 1,
    },
  ];
  const { error: insertError } = await supabase.from('orders').insert({
    id: TEST_ORDER_ID,
    items,
    total: 350,
    payment_method: 'bank_transfer',
    status: 'pending',
    phone_number: '0900000000',
    created_at: new Date().toISOString(),
    tenant_ids: [TENANT],
    payment_proofs: { [TENANT]: TEST_PROOF_PATH },
    shipping_fees: {},
    item_statuses: {},
  });
  if (insertError) throw insertError;
  console.log('test order inserted — trigger fired');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
