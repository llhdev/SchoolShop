/**
 * Resend Telegram order notifications for orders whose original notification
 * provably fell back to text-only (sendMediaGroup WEBPAGE_CURL_FAILED,
 * Nov 2026 incident).
 *
 * Duplicate safety:
 *  - The candidate set is built ONLY from logged sendMediaGroup failures
 *    (supabase/.temp/failure-times.json), never from a bare time window.
 *  - Each failure is matched to the order created within ~6s before it;
 *    matched order ids are DEDUPLICATED, so an order is resent at most once.
 *  - Before sending, every candidate id is re-fetched from the orders table;
 *    ids not present in the orders list are skipped and reported.
 *  - Orders without a matching failure log are never touched (their album
 *    already arrived).
 *
 * Usage:
 *   node scripts/resend-order-notifications.js          # dry-run (default)
 *   node scripts/resend-order-notifications.js --send   # actually resend
 *   node scripts/resend-order-notifications.js --send --only ORDER-ID  # one
 */

const fs = require('fs');
const path = require('path');

// This machine's direct egress is reset (ECONNRESET); PowerShell and the
// browser work through the local proxy at 127.0.0.1:7890. Route node's
// fetch through it too when PROXY_URL is set (or the common default).
const proxyUrl = process.env.PROXY_URL ?? 'http://127.0.0.1:7890';
try {
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
} catch {
  // undici unavailable — fall back to direct connections.
}

// The failure log line lands when Telegram answers, which can trail the
// order insert by tens of seconds on slow proof fetches (observed up to
// ~29s). The matcher always takes the NEAREST order at-or-before the
// failure, so a generous window cannot misattribute when orders are dense.
const MATCH_WINDOW_MS = 35000;
const SEND_DELAY_MS = 1200;

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function restGet(base, key, query) {
  const res = await fetch(`${base}/rest/v1/${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const send = process.argv.includes('--send');
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

  const { EXPO_PUBLIC_SUPABASE_URL: base, EXPO_PUBLIC_SUPABASE_ANON_KEY: key } = loadEnv();
  if (!base || !key) throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL/ANON_KEY in .env');

  const failureTimes = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'supabase', '.temp', 'failure-times.json'), 'utf8')
  ).map((t) => new Date(t.replace(' ', 'T') + (t.endsWith('Z') ? '' : 'Z')).getTime());

  // 1) Match each failure to the order created just before it; dedupe ids.
  const matched = new Map(); // orderId -> { id, created_at, failureTime }
  const unmatched = [];
  for (const failMs of failureTimes) {
    const gte = new Date(failMs - MATCH_WINDOW_MS).toISOString();
    const lte = new Date(failMs).toISOString();
    const rows = await restGet(
      base,
      key,
      `orders?select=id,created_at&created_at=gte.${gte}&created_at=lte.${lte}&order=created_at.desc&limit=5`
    );
    if (rows.length === 0) {
      unmatched.push(new Date(failMs).toISOString());
      continue;
    }
    // Nearest order at-or-before the failure timestamp.
    const row = rows
      .filter((r) => new Date(r.created_at).getTime() <= failMs)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!row) {
      unmatched.push(new Date(failMs).toISOString());
      continue;
    }
    if (!matched.has(row.id)) {
      matched.set(row.id, { id: row.id, created_at: row.created_at, failureTime: new Date(failMs).toISOString() });
    }
  }

  console.log(`Failures: ${failureTimes.length}  ->  unique orders matched: ${matched.size}`);
  if (unmatched.length > 0) {
    console.log(`UNMATCHED failures (${unmatched.length}) — investigate before sending:`);
    unmatched.forEach((t) => console.log(`  ${t}`));
  }

  // 2) Re-fetch candidates by id: anything not in the orders list is skipped.
  const ids = [...matched.keys()];
  const rows = ids.length
    ? await restGet(base, key, `orders?select=*&id=in.(${ids.map((i) => `"${i}"`).join(',')})`)
    : [];
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    console.log(`SKIPPED — not in orders list (${missing.length}): ${missing.join(', ')}`);
  }

  let targets = rows;
  if (only) targets = rows.filter((r) => r.id === only);
  targets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  console.log(`\n${send ? 'SENDING' : 'DRY-RUN'} — ${targets.length} order(s):`);
  for (const r of targets) {
    const m = matched.get(r.id);
    console.log(`  ${r.id}  created=${r.created_at}  failed-at=${m?.failureTime}`);
  }

  if (!send) {
    console.log('\nDry-run only. Re-run with --send to resend these notifications.');
    return;
  }
  if (unmatched.length > 0 || missing.length > 0) {
    console.log('\nRefusing to send: unresolved unmatched/missing entries above.');
    process.exit(1);
  }

  // 3) Resend exactly once per order, as the client would.
  let okCount = 0;
  for (const row of targets) {
    const payload = {
      id: row.id,
      items: row.items,
      total: row.total,
      payment_method: row.payment_method,
      status: row.status,
      location: row.location,
      phone_number: row.phone_number,
      telegram_id: row.telegram_id ?? null,
      created_at: row.created_at,
      payment_proofs: row.payment_proofs ?? {},
      shipping_fees: row.shipping_fees ?? {},
    };
    const res = await fetch(`${base}/functions/v1/telegram-order-notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    const warnings = (body?.notified ?? []).filter((n) => n.warning);
    console.log(
      `  ${row.id}: HTTP ${res.status} notified=${(body?.notified ?? []).length} ` +
        `skipped=${JSON.stringify(body?.skipped ?? [])}${warnings.length ? ` WARN=${JSON.stringify(warnings)}` : ''}`
    );
    if (res.ok) okCount++;
    await sleep(SEND_DELAY_MS);
  }
  console.log(`\nDone. ${okCount}/${targets.length} resend calls succeeded.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
