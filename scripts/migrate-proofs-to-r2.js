// One-off migration: move payment proofs from the Supabase private bucket
// `payment-proofs-private` to the PRIVATE Cloudflare R2 bucket
// `timor-shop-proofs`. Object KEYS ARE KEPT IDENTICAL, so
// orders.payment_proofs needs no rewrite — only the storage backend moves.
//
// The bucket is private by default (no public access, no custom domain) —
// all app access goes through presigned URLs (see
// supabase/functions/_shared/r2Sign.ts).
//
// Usage:
//   node scripts/migrate-proofs-to-r2.js            dry run — report only
//   node scripts/migrate-proofs-to-r2.js --apply    create bucket + copy
//   node scripts/migrate-proofs-to-r2.js --apply --delete
//                                                   also delete the Supabase
//                                                   copies (after size check)
//
// Required env (set in .env or the shell):
//   EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//
// Safe to re-run: objects already in R2 with the same byte size are skipped,
// so re-running catches proofs uploaded while the migration was in flight.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
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
// the local proxy when one is listening. Retries cover mid-run drops.
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
const CONCURRENCY = 8;

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_PROOFS_BUCKET || 'timor-shop-proofs';
const SOURCE_BUCKET = 'payment-proofs-private';

for (const [name, value] of Object.entries({
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
})) {
  if (!value) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- minimal SigV4 (header auth) for R2, region is always 'auto' --------------

const R2_HOST = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function signingKey(dateStamp) {
  return hmac(hmac(hmac(hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp), 'auto'), 's3'), 'aws4_request');
}

/** Signed request against R2. `objectPath` starts with '/'; `query` is a
 *  plain object of S3 query params (values '' for bare flags). */
async function r2Request(method, objectPath, query, body, extraHeaders) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const canonicalQuery = Object.entries(query || {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const canonicalHeaders = `host:${R2_HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, objectPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(dateStamp)).update(stringToSign).digest('hex');
  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    ...extraHeaders,
  };
  const qs = canonicalQuery ? `?${canonicalQuery}` : '';
  return withRetry(() =>
    fetch(`https://${R2_HOST}${objectPath}${qs}`, { method, headers, body: body || undefined })
  );
}

// --- R2 bucket ops ---------------------------------------------------------------

async function ensureBucket() {
  // Bucket-scoped tokens can't create buckets (403) — probe with a list
  // first; only attempt creation when the bucket is genuinely missing.
  const probe = await r2Request('GET', `/${R2_BUCKET}`, { 'list-type': '2', 'max-keys': '1' }, null);
  if (probe.ok) {
    console.log(`R2 bucket ${R2_BUCKET} exists`);
    return;
  }
  const probeText = await probe.text();
  if (probe.status !== 404 && !probeText.includes('NoSuchBucket')) {
    throw new Error(`bucket probe failed: HTTP ${probe.status} ${probeText}`);
  }
  const res = await r2Request('PUT', `/${R2_BUCKET}`, {}, null);
  if (res.ok) {
    console.log(`created R2 bucket ${R2_BUCKET} (private by default)`);
    return;
  }
  const text = await res.text();
  if (res.status === 409 && text.includes('BucketAlreadyOwnedByYou')) {
    console.log(`R2 bucket ${R2_BUCKET} already exists`);
    return;
  }
  throw new Error(
    `create bucket failed: HTTP ${res.status} ${text}\n` +
      `The R2 token is bucket-scoped — create the bucket "${R2_BUCKET}" in the Cloudflare dashboard first.`
  );
}

/** All R2 object keys -> sizes via ListObjectsV2 (paginated). */
async function listR2Objects() {
  const sizes = new Map();
  let token;
  do {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await r2Request('GET', `/${R2_BUCKET}`, query, null);
    if (res.status === 404) return sizes; // bucket does not exist yet
    if (!res.ok) throw new Error(`R2 list failed: HTTP ${res.status} ${await res.text()}`);
    const xml = await res.text();
    for (const match of xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
      sizes.set(match[1], Number(match[2]));
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1]
      : undefined;
  } while (token);
  return sizes;
}

// --- Supabase source -------------------------------------------------------------

async function listSourceObjects() {
  const objects = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await withRetry(() =>
      supabase.storage.from(SOURCE_BUCKET).list('', { limit: PAGE, offset })
    );
    if (error) throw new Error(`list ${SOURCE_BUCKET} failed: ${error.message}`);
    const files = (data || []).filter((o) => o.name && o.name !== '.emptyFolderPlaceholder');
    objects.push(...files);
    if (files.length < PAGE) return objects;
  }
}

async function main() {
  await setupProxy();
  console.log(APPLY ? 'Mode: APPLY (copying)' : 'Mode: DRY RUN (report only)');
  if (DELETE_SOURCE && !APPLY) {
    console.error('--delete requires --apply');
    process.exit(1);
  }

  if (APPLY) await ensureBucket();

  const r2Sizes = APPLY ? await listR2Objects() : new Map();
  if (APPLY) console.log(`${R2_BUCKET}: ${r2Sizes.size} existing objects`);

  const objects = await listSourceObjects();
  console.log(`${SOURCE_BUCKET}: ${objects.length} objects to migrate\n`);

  let copied = 0, skipped = 0, deleted = 0, failed = 0;

  async function processOne(object) {
    const size = object.metadata?.size ?? null;
    const existing = r2Sizes.get(object.name) ?? null;
    try {
      if (existing !== null && (size === null || existing === size)) {
        skipped++;
      } else if (APPLY) {
        const { data, error } = await withRetry(() =>
          supabase.storage.from(SOURCE_BUCKET).download(object.name)
        );
        if (error) throw new Error(`download failed: ${error.message}`);
        const buffer = Buffer.from(await data.arrayBuffer());
        const res = await r2Request('PUT', `/${R2_BUCKET}/${object.name}`, {}, buffer, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, no-cache',
        });
        if (!res.ok) throw new Error(`R2 upload failed: HTTP ${res.status} ${await res.text()}`);
        r2Sizes.set(object.name, buffer.length);
        copied++;
      } else {
        copied++; // would copy
      }

      if (DELETE_SOURCE && APPLY) {
        const verified = r2Sizes.get(object.name) ?? null;
        if (verified !== null && (size === null || verified === size)) {
          const { data: removed, error } = await withRetry(() =>
            supabase.storage.from(SOURCE_BUCKET).remove([object.name])
          );
          // RLS silently turns unauthorized DELETEs into {data:[],error:null}
          // — treat 0-row removes as errors.
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

  for (let i = 0; i < objects.length; i += CONCURRENCY) {
    await Promise.all(objects.slice(i, i + CONCURRENCY).map(processOne));
    if ((i / CONCURRENCY) % 10 === 9) {
      console.log(`  progress: ${Math.min(i + CONCURRENCY, objects.length)}/${objects.length}`);
    }
  }

  console.log(
    `\n${APPLY ? 'copied' : 'to copy'}: ${copied}, already in R2: ${skipped}` +
      (DELETE_SOURCE ? `, deleted from Supabase: ${deleted}` : '') +
      (failed ? `, FAILED: ${failed}` : '')
  );
  console.log('\nDone.' + (APPLY ? '' : ' Re-run with --apply to perform the migration.'));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
