// Audit: HEAD every product image URL (and derived thumbnail) and report any
// that don't return 200. Catches the "full image missing from R2, URL stored
// on the product" failure mode — products list fine (thumbnail) but the
// detail page, zoom viewer, and Telegram order album all break.
//
// Usage:
//   node scripts/check-product-images.js
//
// Env: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY from .env
// (products are publicly readable). Exits 1 when any broken URL is found, so
// it can run as a scheduled check.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

async function setupProxy() {
  const envProxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? null;
  let proxyUrl = envProxy;
  if (!proxyUrl) {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: 7890, timeout: 1500 });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
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
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

function getThumbnailUrl(imageUrl) {
  if (!imageUrl.startsWith('http')) return imageUrl;
  const withoutQuery = imageUrl.split('?')[0];
  if (!withoutQuery.toLowerCase().endsWith('.jpg')) return imageUrl;
  return withoutQuery.replace(/\.jpg$/i, '-thumb.jpg');
}

async function headStatus(imageUrl) {
  try {
    const response = await fetch(imageUrl, { method: 'HEAD' });
    return response.status;
  } catch (error) {
    return `network error: ${error.message}`;
  }
}

async function main() {
  await setupProxy();
  const supabase = createClient(url, anonKey);
  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, images, detail_images');
  if (error) {
    console.error('Query error:', error);
    process.exit(1);
  }

  let broken = 0;
  for (const product of products ?? []) {
    const urls = [...(product.images ?? []), ...(product.detail_images ?? [])];
    for (const imageUrl of urls) {
      if (!imageUrl || !imageUrl.startsWith('http')) continue;
      for (const candidate of [imageUrl, getThumbnailUrl(imageUrl)]) {
        const status = await headStatus(candidate);
        if (status !== 200) {
          broken++;
          console.log(`BROKEN [${status}] ${product.name} (${product.id})\n  ${candidate}`);
        }
      }
    }
  }

  console.log(
    broken === 0
      ? `OK — all images of ${products?.length ?? 0} products reachable.`
      : `\n${broken} broken image URL(s) found.`
  );
  process.exit(broken === 0 ? 0 : 1);
}

main();
