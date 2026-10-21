// One-off migration: copy every public display image from Supabase Storage
// (product-images, shop-logos, bank-qrs) to the Cloudflare R2 bucket, rewrite
// the URLs stored in the database, and — only after a verified copy — delete
// the Supabase objects to reclaim space. Payment proofs stay on Supabase
// (private bucket, server-side readers) and are not touched.
//
// Usage:
//   node scripts/migrate-images-to-r2.js            dry run — report only
//   node scripts/migrate-images-to-r2.js --apply    copy to R2 + rewrite DB URLs
//   node scripts/migrate-images-to-r2.js --apply --delete
//                                                   also delete the Supabase
//                                                   objects (after verifying
//                                                   each R2 copy by size)
//
// Required env (set in .env or the shell):
//   EXPO_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (falls back to EXPO_PUBLIC_SUPABASE_ANON_KEY —
//                               fine while RLS allows public read/write)
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//   R2_BUCKET                  (default timor-shop-images)
//   R2_PUBLIC_BASE_URL         (default https://img.timor.et)
//
// Safe to re-run: objects already in R2 with the same byte size are skipped,
// and DB rows already pointing at R2 are left alone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

// supabase.co is intermittently unreachable from this network; route through
// the local proxy when one is listening (same pattern as
// scripts/test-reference-verification.js). Retries below cover the proxy
// dropping mid-run.
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

const APPLY = process.argv.includes('--apply');
const DELETE_SOURCE = process.argv.includes('--delete');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'timor-shop-images';
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || 'https://img.timor.et').replace(/\/+$/, '');

for (const [name, value] of Object.entries({
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_KEY: SERVICE_KEY,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
})) {
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// bucket -> R2 key prefix
const BUCKETS = [
  { bucket: 'product-images', prefix: 'products/' },
  { bucket: 'shop-logos', prefix: 'logos/' },
  { bucket: 'bank-qrs', prefix: 'qrs/' },
];

// --- minimal SigV4 (header auth) for R2 --------------------------------------

const R2_HOST = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function signingKey(dateStamp) {
  return hmac(hmac(hmac(hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp), 'auto'), 's3'), 'aws4_request');
}

async function r2Request(method, key, body) {
  const objectPath = `/${R2_BUCKET}/${key}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const canonicalHeaders = `host:${R2_HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, objectPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
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
  };
  if (body) {
    headers['Content-Type'] = 'image/jpeg';
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }
  return fetch(`https://${R2_HOST}${objectPath}`, { method, headers, body });
}

/** Byte size of the R2 object, or null when missing. */
async function r2Size(key) {
  const res = await r2Request('HEAD', key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 HEAD ${key} failed: HTTP ${res.status}`);
  const len = res.headers.get('content-length');
  return len === null ? null : Number(len);
}

// --- Supabase listing / download ----------------------------------------------

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

// --- URL rewriting ---------------------------------------------------------------

/** Map a Supabase public storage URL to its R2 URL; returns null for anything
 *  else (already R2, external, empty). */
function toR2Url(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/object\/public\/(product-images|shop-logos|bank-qrs)\/(.+)$/);
  if (!match) return null;
  const prefix = BUCKETS.find((b) => b.bucket === match[1]).prefix;
  return `${R2_PUBLIC_BASE_URL}/${prefix}${match[2]}`;
}

function rewriteUrl(url) {
  return toR2Url(url) ?? url;
}

async function rewriteDatabase() {
  let updated = 0;

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, images, detail_images');
  if (productsError) throw new Error(`products select failed: ${productsError.message}`);
  for (const product of products || []) {
    const images = (product.images || []).map(rewriteUrl);
    const detailImages = (product.detail_images || []).map(rewriteUrl);
    const changed =
      JSON.stringify(images) !== JSON.stringify(product.images || []) ||
      JSON.stringify(detailImages) !== JSON.stringify(product.detail_images || []);
    if (!changed) continue;
    updated++;
    if (APPLY) {
      const { error } = await supabase
        .from('products')
        .update({ images, detail_images: detailImages })
        .eq('id', product.id);
      if (error) throw new Error(`product ${product.id} update failed: ${error.message}`);
    }
  }
  console.log(`  products rows ${APPLY ? 'updated' : 'to update'}: ${updated}`);

  let profilesUpdated = 0;
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, shop_logo_url, bank_accounts');
  if (profilesError) throw new Error(`profiles select failed: ${profilesError.message}`);
  for (const profile of profiles || []) {
    const shopLogoUrl = rewriteUrl(profile.shop_logo_url);
    const bankAccounts = Array.isArray(profile.bank_accounts)
      ? profile.bank_accounts.map((a) =>
          a && typeof a === 'object' && 'qr_image_url' in a
            ? { ...a, qr_image_url: rewriteUrl(a.qr_image_url) }
            : a
        )
      : profile.bank_accounts;
    const changed =
      shopLogoUrl !== profile.shop_logo_url ||
      JSON.stringify(bankAccounts) !== JSON.stringify(profile.bank_accounts);
    if (!changed) continue;
    profilesUpdated++;
    if (APPLY) {
      const { error } = await supabase
        .from('profiles')
        .update({ shop_logo_url: shopLogoUrl, bank_accounts: bankAccounts })
        .eq('id', profile.id);
      if (error) throw new Error(`profile ${profile.id} update failed: ${error.message}`);
    }
  }
  console.log(`  profiles rows ${APPLY ? 'updated' : 'to update'}: ${profilesUpdated}`);
}

// --- main -------------------------------------------------------------------------

async function main() {
  await setupProxy();
  console.log(APPLY ? 'Mode: APPLY (copying + rewriting)' : 'Mode: DRY RUN (report only)');
  if (DELETE_SOURCE && !APPLY) {
    console.error('--delete requires --apply');
    process.exit(1);
  }

  for (const { bucket, prefix } of BUCKETS) {
    const objects = await listAllObjects(bucket);
    console.log(`\n${bucket}: ${objects.length} objects`);
    let copied = 0, skipped = 0, deleted = 0, failed = 0;

    for (const object of objects) {
      const key = `${prefix}${object.name}`;
      const size = object.metadata?.size ?? null;
      try {
        const existing = await r2Size(key);
        if (existing !== null && (size === null || existing === size)) {
          skipped++;
        } else if (APPLY) {
          const { data, error } = await withRetry(() =>
            supabase.storage.from(bucket).download(object.name)
          );
          if (error) throw new Error(`download failed: ${error.message}`);
          const buffer = Buffer.from(await data.arrayBuffer());
          const res = await withRetry(() => r2Request('PUT', key, buffer));
          if (!res.ok) throw new Error(`R2 PUT failed: HTTP ${res.status}`);
          copied++;
        } else {
          copied++; // would copy
        }

        if (DELETE_SOURCE && APPLY) {
          const verified = await r2Size(key);
          if (verified !== null && (size === null || verified === size)) {
            const { data: removed, error } = await withRetry(() =>
              supabase.storage.from(bucket).remove([object.name])
            );
            if (error) throw new Error(`delete failed: ${error.message}`);
            // RLS silently turns an unauthorized DELETE into a 0-row success.
            if (!removed || removed.length === 0) {
              throw new Error('delete blocked by RLS (needs SUPABASE_SERVICE_ROLE_KEY in .env)');
            }
            deleted++;
          }
        }
      } catch (error) {
        failed++;
        console.error(`  FAILED ${bucket}/${object.name}: ${error.message}`);
      }
    }
    console.log(
      `  ${APPLY ? 'copied' : 'to copy'}: ${copied}, already in R2: ${skipped}` +
        (DELETE_SOURCE ? `, deleted from Supabase: ${deleted}` : '') +
        (failed ? `, FAILED: ${failed}` : '')
    );
  }

  console.log('\nRewriting database URLs:');
  await rewriteDatabase();

  console.log('\nDone.' + (APPLY ? '' : ' Re-run with --apply to perform the migration.'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
