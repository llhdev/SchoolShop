// One-off migration: move legacy payment proofs from the PUBLIC
// `payment-proofs` bucket (pre-migration-040) into the PRIVATE
// `payment-proofs-private` bucket, and rewrite orders.payment_proofs values
// from full public URLs to bare object paths. All readers (verify-order-
// payment, telegram-order-notify, admin OrderDetail) already handle both
// forms, so no app changes are needed. Proofs stay on Supabase by design —
// this is a public -> private move, not an R2 move.
//
// Usage:
//   node scripts/migrate-proofs-to-private.js            dry run — report only
//   node scripts/migrate-proofs-to-private.js --apply    copy + rewrite orders
//   node scripts/migrate-proofs-to-private.js --apply --delete
//                                                        also delete the public
//                                                        objects (after size check)
//
// Required env (set in .env or the shell):
//   EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Safe to re-run: objects already in the private bucket with the same byte
// size are skipped, and orders already holding bare paths are left alone.

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

// supabase.co is intermittently unreachable from this network; route through
// the local proxy when one is listening (same pattern as
// scripts/test-reference-verification.js). Retries cover mid-run drops.
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

async function withRetry(fn, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastError;
}

const APPLY = process.argv.includes('--apply');
const DELETE_SOURCE = process.argv.includes('--delete');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env: EXPO_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PUBLIC_BUCKET = 'payment-proofs';
const PRIVATE_BUCKET = 'payment-proofs-private';
const PUBLIC_URL_MARKER = `/object/public/${PUBLIC_BUCKET}/`;

async function listAllObjects(bucket) {
  const objects = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await withRetry(() =>
      supabase.storage.from(bucket).list('', { limit: PAGE, offset })
    );
    if (error) throw new Error(`list ${bucket} failed: ${error.message}`);
    const files = (data || []).filter((o) => o.name && o.name !== '.emptyFolderPlaceholder');
    objects.push(...files);
    if (files.length < PAGE) return objects;
  }
}

/** Private-bucket object sizes by name, fetched once (service role can list
 *  private buckets) and extended as we upload — avoids downloading every
 *  object just to check it exists. */
const privateSizes = new Map();

async function loadPrivateIndex() {
  const objects = await listAllObjects(PRIVATE_BUCKET);
  for (const o of objects) privateSizes.set(o.name, o.metadata?.size ?? null);
  console.log(`${PRIVATE_BUCKET}: ${objects.length} existing objects`);
}

async function rewriteOrders() {
  // Orders referencing the legacy public URLs. Values are unique per upload
  // (timestamp-random filenames), so each public object maps 1:1.
  // Paginated — PostgREST silently caps responses at 1000 rows.
  let updated = 0;
  for (let from = 0; ; from += 1000) {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, payment_proofs')
      .not('payment_proofs', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`orders select failed: ${error.message}`);
    for (const order of orders || []) {
      const proofs = order.payment_proofs || {};
      let changed = false;
      const next = {};
      for (const [ownerId, ref] of Object.entries(proofs)) {
        if (typeof ref === 'string' && ref.includes(PUBLIC_URL_MARKER)) {
          next[ownerId] = ref.slice(ref.indexOf(PUBLIC_URL_MARKER) + PUBLIC_URL_MARKER.length);
          changed = true;
        } else {
          next[ownerId] = ref;
        }
      }
      if (!changed) continue;
      updated++;
      if (APPLY) {
        const { error: updateError } = await withRetry(() =>
          supabase.from('orders').update({ payment_proofs: next }).eq('id', order.id)
        );
        if (updateError) throw new Error(`order ${order.id} update failed: ${updateError.message}`);
      }
    }
    if ((orders || []).length < 1000) break;
  }
  console.log(`  orders ${APPLY ? 'updated' : 'to update'}: ${updated}`);
}

async function main() {
  await setupProxy();
  console.log(APPLY ? 'Mode: APPLY (copying + rewriting)' : 'Mode: DRY RUN (report only)');
  if (DELETE_SOURCE && !APPLY) {
    console.error('--delete requires --apply');
    process.exit(1);
  }

  const objects = await listAllObjects(PUBLIC_BUCKET);
  console.log(`\n${PUBLIC_BUCKET}: ${objects.length} objects`);
  await loadPrivateIndex();
  let copied = 0, skipped = 0, deleted = 0, failed = 0;

  for (const object of objects) {
    const size = object.metadata?.size ?? null;
    try {
      const existing = privateSizes.get(object.name) ?? null;
      if (existing !== null && (size === null || existing === size)) {
        skipped++;
      } else if (APPLY) {
        const { data, error } = await withRetry(() =>
          supabase.storage.from(PUBLIC_BUCKET).download(object.name)
        );
        if (error) throw new Error(`download failed: ${error.message}`);
        const buffer = Buffer.from(await data.arrayBuffer());
        const { error: uploadError } = await withRetry(() =>
          supabase.storage.from(PRIVATE_BUCKET).upload(object.name, buffer, {
            contentType: 'image/jpeg',
            cacheControl: '31536000',
            upsert: false,
          })
        );
        if (uploadError) throw new Error(`private upload failed: ${uploadError.message}`);
        privateSizes.set(object.name, buffer.length);
        copied++;
      } else {
        copied++; // would copy
      }

      if (DELETE_SOURCE && APPLY) {
        const verified = privateSizes.get(object.name) ?? null;
        if (verified !== null && (size === null || verified === size)) {
          const { data: removed, error } = await withRetry(() =>
            supabase.storage.from(PUBLIC_BUCKET).remove([object.name])
          );
          if (error) throw new Error(`delete failed: ${error.message}`);
          if (!removed || removed.length === 0) throw new Error('delete removed 0 rows');
          deleted++;
        }
      }
    } catch (error) {
      failed++;
      console.error(`  FAILED ${object.name}: ${error.message}`);
    }
  }
  console.log(
    `  ${APPLY ? 'copied' : 'to copy'}: ${copied}, already private: ${skipped}` +
      (DELETE_SOURCE ? `, deleted from public: ${deleted}` : '') +
      (failed ? `, FAILED: ${failed}` : '')
  );

  console.log('\nRewriting orders.payment_proofs:');
  await rewriteOrders();

  console.log('\nDone.' + (APPLY ? '' : ' Re-run with --apply to perform the migration.'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
