// Reports Supabase Storage usage per bucket (count + bytes), recent growth
// rate (objects/day over the last 30 days), average object size, and an
// estimate of when the free-tier 1 GB file-storage limit would be hit at
// the current growth rate. Read-only.
//
// Usage: node scripts/check-storage-usage.js
// Env (from .env): EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

const FREE_TIER_BYTES = 1024 * 1024 * 1024; // 1 GB file storage on the free plan

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function main() {
  await setupProxy();
  const supabase = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // Walk every bucket recursively via the Storage list API (the `storage`
  // schema is not exposed over PostgREST, so direct table queries fail).
  const { data: buckets, error: bucketErr } = await supabase.storage.listBuckets();
  if (bucketErr) throw new Error(`listBuckets: ${bucketErr.message}`);

  async function listRecursive(bucketId, prefix) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.storage.from(bucketId).list(prefix, {
        limit: 1000,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(`list ${bucketId}/${prefix}: ${error.message}`);
      if (!data.length) break;
      for (const entry of data) {
        if (entry.id === null) {
          out.push(...(await listRecursive(bucketId, prefix ? `${prefix}/${entry.name}` : entry.name)));
        } else {
          out.push({
            created_at: entry.created_at,
            size: (entry.metadata && entry.metadata.size) || 0,
          });
        }
      }
      if (data.length < 1000) break;
    }
    return out;
  }

  const perBucket = new Map();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  for (const bucket of buckets) {
    const objects = await listRecursive(bucket.id, '');
    const b = { count: 0, bytes: 0, last30Count: 0, last30Bytes: 0, oldestDays: 0 };
    for (const o of objects) {
      const ageDays = (now - new Date(o.created_at).getTime()) / DAY;
      b.count += 1;
      b.bytes += o.size;
      if (ageDays <= 30) {
        b.last30Count += 1;
        b.last30Bytes += o.size;
      }
      if (ageDays > b.oldestDays) b.oldestDays = ageDays;
    }
    perBucket.set(bucket.id, b);
  }

  let totalBytes = 0;
  let totalLast30Bytes = 0;
  console.log('\n=== Supabase Storage usage ===');
  for (const [bucket, b] of [...perBucket.entries()].sort((a, z) => z[1].bytes - a[1].bytes)) {
    totalBytes += b.bytes;
    totalLast30Bytes += b.last30Bytes;
    const avgKb = b.count ? (b.bytes / b.count / 1024).toFixed(0) : 0;
    console.log(
      `\n${bucket}\n` +
        `  objects:            ${b.count}\n` +
        `  total size:         ${mb(b.bytes)} MB\n` +
        `  avg object size:    ${avgKb} KB\n` +
        `  last 30 days:       ${b.last30Count} objects, ${mb(b.last30Bytes)} MB\n` +
        `  oldest object:      ${b.oldestDays.toFixed(0)} days ago`
    );
  }

  let totalCount = 0;
  for (const b of perBucket.values()) totalCount += b.count;
  console.log('\n=== Totals ===');
  console.log(`all buckets:          ${totalCount} objects, ${mb(totalBytes)} MB`);
  console.log(`added last 30 days:   ${mb(totalLast30Bytes)} MB (${(totalLast30Bytes / 30 / (1024 * 1024)).toFixed(2)} MB/day)`);

  const remaining = FREE_TIER_BYTES - totalBytes;
  const dailyGrowth = totalLast30Bytes / 30;
  console.log(`\nfree-tier limit:      ${mb(FREE_TIER_BYTES)} MB (1 GB file storage)`);
  console.log(`used:                 ${mb(totalBytes)} MB (${((totalBytes / FREE_TIER_BYTES) * 100).toFixed(1)}%)`);
  console.log(`remaining:            ${mb(remaining)} MB`);
  if (dailyGrowth > 0) {
    const daysLeft = remaining / dailyGrowth;
    console.log(`growth rate:          ${(dailyGrowth / (1024 * 1024)).toFixed(2)} MB/day`);
    if (daysLeft > 365) {
      console.log(`estimated time to limit: ~${(daysLeft / 365).toFixed(1)} years`);
    } else if (daysLeft > 60) {
      console.log(`estimated time to limit: ~${(daysLeft / 30.4).toFixed(1)} months`);
    } else {
      console.log(`estimated time to limit: ~${daysLeft.toFixed(0)} days`);
    }
  } else {
    console.log('no growth in the last 30 days — cannot estimate');
  }

  // Context: orders per day over the same window.
  const since = new Date(now - 30 * DAY).toISOString();
  const { count, error: ordErr } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);
  if (!ordErr) console.log(`\norders last 30 days:  ${count} (~${(count / 30).toFixed(1)}/day)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
