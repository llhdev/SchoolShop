// Live test for the verify-payment-reference edge function (041).
// Uploads a real proof image to the private bucket, then exercises the
// DEPLOYED function with genuine CBE / Telebirr references and asserts the
// verdict contract:
//   (a) correct reference          -> 'verified'
//   (b) tampered amount (qty + 1)  -> 'wrong_amount'
//   (c) bogus reference            -> 'not_found'
//   (d) replay of (a)'s exact key  -> cached verdict, identical payload
//
// Required env (set in .env or the shell):
//   EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY      (proof upload; falls back to anon —
//                                   the bucket allows public INSERT)
//   TEST_TENANT_ID                 uuid of the shop the receipt paid
//   TEST_PRODUCT_ID                a product owned by that shop
//   PROOF_IMAGE                    local path to the real proof screenshot
//   CBE_REFERENCE and/or TELEBIRR_REFERENCE   genuine transaction reference(s)
// Optional:
//   TEST_PRODUCT_QUANTITY          default 1
//
// Run: node scripts/test-reference-verification.js
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

const TENANT = process.env.TEST_TENANT_ID;
const PRODUCT_ID = process.env.TEST_PRODUCT_ID;
const QUANTITY = Number(process.env.TEST_PRODUCT_QUANTITY || '1');
const PROOF_IMAGE = process.env.PROOF_IMAGE;
const REFERENCES = {
  cbe: process.env.CBE_REFERENCE,
  telebirr: process.env.TELEBIRR_REFERENCE,
};

// Bogus references that still pass the function's per-provider charset
// validation, so they reach verify.et and come back not_found.
const BOGUS_REFERENCE = { cbe: 'ZZZZ00000000', telebirr: 'ZZZZZZZZZZ' };

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

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

async function callPrecheck({ provider, reference, key, proofRef, quantity }) {
  const res = await fetch(`${url}/functions/v1/verify-payment-reference`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({
      tenantId: TENANT,
      provider,
      reference,
      key,
      proofRef,
      items: [{ productId: PRODUCT_ID, quantity }],
    }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function runProviderSuite(provider, reference, proofRef) {
  console.log(`\n--- ${provider} (reference ${reference}) ---`);

  // (a) correct reference -> verified
  const keyA = crypto.randomUUID();
  const a = await callPrecheck({ provider, reference, key: keyA, proofRef, quantity: QUANTITY });
  check(
    `${provider}: correct reference verifies`,
    a.status === 200 && a.body?.verdict === 'verified',
    `HTTP ${a.status} ${JSON.stringify(a.body)}`
  );

  // (b) tampered amount: bump the quantity so the expected amount no longer
  // matches the receipt (fresh key — a verdict change must not replay (a)).
  const b = await callPrecheck({
    provider,
    reference,
    key: crypto.randomUUID(),
    proofRef,
    quantity: QUANTITY + 1,
  });
  check(
    `${provider}: tampered amount is rejected`,
    b.status === 200 && b.body?.verdict === 'wrong_amount',
    `HTTP ${b.status} ${JSON.stringify(b.body)}`
  );

  // (c) bogus reference -> not_found
  const c = await callPrecheck({
    provider,
    reference: BOGUS_REFERENCE[provider],
    key: crypto.randomUUID(),
    proofRef,
    quantity: QUANTITY,
  });
  check(
    `${provider}: bogus reference is not_found`,
    c.status === 200 && c.body?.verdict === 'not_found',
    `HTTP ${c.status} ${JSON.stringify(c.body)}`
  );

  // (d) replay of (a)'s exact request -> same cached verdict, no new call
  const d = await callPrecheck({ provider, reference, key: keyA, proofRef, quantity: QUANTITY });
  check(
    `${provider}: same-key replay returns cached verdict`,
    d.status === 200 &&
      d.body?.verdict === a.body?.verdict &&
      d.body?.paidAmount === a.body?.paidAmount &&
      d.body?.expectedAmount === a.body?.expectedAmount &&
      d.body?.requestId === a.body?.requestId,
    `HTTP ${d.status} ${JSON.stringify(d.body)} vs ${JSON.stringify(a.body)}`
  );
}

async function main() {
  const missing = [];
  if (!url) missing.push('EXPO_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  if (!TENANT) missing.push('TEST_TENANT_ID');
  if (!PRODUCT_ID) missing.push('TEST_PRODUCT_ID');
  if (!PROOF_IMAGE) missing.push('PROOF_IMAGE');
  if (!REFERENCES.cbe && !REFERENCES.telebirr) missing.push('CBE_REFERENCE and/or TELEBIRR_REFERENCE');
  if (missing.length > 0) {
    console.error(`missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!Number.isInteger(QUANTITY) || QUANTITY <= 0) {
    console.error('TEST_PRODUCT_QUANTITY must be a positive integer');
    process.exit(1);
  }

  await setupProxy();
  const supabase = createClient(url, serviceKey || anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Upload the real proof; the function refuses to verify without one.
  const bytes = fs.readFileSync(PROOF_IMAGE);
  const contentType = PROOF_IMAGE.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const proofRef = `test-ref-proof-${Date.now()}.${contentType === 'image/png' ? 'png' : 'jpg'}`;
  const { error: upError } = await supabase.storage
    .from('payment-proofs-private')
    .upload(proofRef, bytes, { contentType, upsert: false });
  if (upError) throw upError;
  console.log(`proof uploaded: ${proofRef} (${bytes.length} bytes)`);

  if (REFERENCES.cbe) await runProviderSuite('cbe', REFERENCES.cbe, proofRef);
  if (REFERENCES.telebirr) await runProviderSuite('telebirr', REFERENCES.telebirr, proofRef);

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
