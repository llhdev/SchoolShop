// One-off backfill: re-send Telegram group notifications for orders placed
// while the telegram-order-notify pipeline was down (Oct 10-11, 2026 outage).
//
// The orders table already stores everything the telegram-order-notify Edge
// Function needs (items stamped with owner_id/shop_name, payment_proofs,
// shipping_fees), so this script just re-POSTs each order in the time window
// to the function — exactly like the app does at checkout.
//
// Usage:
//   node scripts/resend-telegram-notifications.js --dry-run
//       Lists the orders in the window without sending anything.
//   node scripts/resend-telegram-notifications.js
//       Sends each order to the tenant Telegram groups.
//   node scripts/resend-telegram-notifications.js --from 2026-10-10T03:36:00+03:00 --to 2026-10-11T17:02:00+03:00
//       Overrides the window (ISO timestamps, include the +03:00 offset for
//       local EAT time).
//
// Env: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY from .env.
// Order SELECT is public (migration 016) and the function's auth gate accepts
// the anon key, so no service role key is needed.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

// This machine's shell has no direct outbound HTTPS (TCP 443 is filtered);
// traffic goes through the local proxy on 127.0.0.1:7890. Node's global fetch
// ignores proxy env vars, so when a proxy is configured (HTTPS_PROXY env var)
// or the default local proxy port is reachable, install an undici ProxyAgent
// as the global dispatcher — supabase-js uses the global fetch too.
async function setupProxy() {
  const envProxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? null;

  let proxyUrl = envProxy;
  if (!proxyUrl) {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: 7890, timeout: 1500 });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) proxyUrl = 'http://127.0.0.1:7890';
  }

  if (proxyUrl) {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`Routing requests through proxy: ${proxyUrl}\n`);
  }
}

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

if (!url || !anonKey) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const dryRun = process.argv.includes('--dry-run');
const from = getArg('from') ?? '2026-10-10T03:36:00+03:00';
const to = getArg('to') ?? '2026-10-11T17:02:00+03:00';

if (Number.isNaN(new Date(from).getTime()) || Number.isNaN(new Date(to).getTime())) {
  console.error('Invalid --from/--to timestamp. Use ISO format, e.g. 2026-10-10T03:36:00+03:00');
  process.exit(1);
}

const supabase = createClient(url, anonKey);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await setupProxy();

  console.log(`Window: ${from}  ->  ${to}${dryRun ? '  (DRY RUN — nothing will be sent)' : ''}\n`);

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, items, total, payment_method, status, location, phone_number, created_at, telegram_id, tenant_ids, payment_proofs, shipping_fees')
    .gte('created_at', from)
    .lt('created_at', to)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch orders:', error.message);
    process.exit(1);
  }

  if (!orders || orders.length === 0) {
    console.log('No orders found in this window. Adjust --from/--to and try again.');
    return;
  }

  console.log(`Found ${orders.length} order(s):\n`);
  for (const order of orders) {
    console.log(
      `  ${order.id}  ${order.created_at}  ${order.phone_number}  ${order.total} ETB  tenants: ${(order.tenant_ids ?? []).length}`
    );
  }

  if (dryRun) {
    console.log('\nDry run complete. Re-run without --dry-run to send these to Telegram.');
    return;
  }

  console.log('');
  let sent = 0;
  let failed = 0;

  for (const order of orders) {
    const payload = {
      id: order.id,
      items: order.items,
      total: order.total,
      payment_method: order.payment_method,
      status: order.status,
      location: order.location,
      phone_number: order.phone_number,
      telegram_id: order.telegram_id ?? null,
      created_at: order.created_at,
      payment_proofs: order.payment_proofs ?? {},
      shipping_fees: order.shipping_fees ?? {},
    };

    try {
      const res = await fetch(`${url}/functions/v1/telegram-order-notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        failed++;
        console.error(`  ${order.id}: HTTP ${res.status}`, body ?? '');
      } else {
        const notified = (body?.notified ?? []).map((n) => n.shop);
        const skipped = (body?.skipped ?? []).map((s) => `${s.shop} (${s.reason})`);
        if (skipped.length > 0) failed++;
        else sent++;
        console.log(
          `  ${order.id}: notified [${notified.join(', ')}]` +
            (skipped.length > 0 ? `  SKIPPED [${skipped.join(', ')}]` : '')
        );
      }
    } catch (err) {
      failed++;
      console.error(`  ${order.id}: request failed:`, err.message ?? err);
    }

    // Stay clear of Telegram rate limits.
    await sleep(1000);
  }

  console.log(`\nDone. ${sent} order(s) fully delivered, ${failed} with skips/errors.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
