// Presigned uploads + deletes for Cloudflare R2 (public display images only:
// product photos, shop logos, bank QRs). The R2 secret key never leaves this
// function — admins request a short-lived presigned PUT URL and upload bytes
// straight to R2, then store the public URL (https://img.timor.et/<key>).
//
// verify_jwt is off at the gateway (the app calls this with the user's own
// access token, and OPTIONS must be answered for browsers), so the function
// authenticates the caller itself: bearer token -> auth.getUser -> profiles
// role must be 'admin' or 'super_admin'. This is stricter than the public-
// write Supabase buckets it replaces.
//
// Required secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET, R2_PUBLIC_BASE_URL. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? '';
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? '';
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? '';
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? 'timor-shop-images';
const R2_PUBLIC_BASE_URL = (Deno.env.get('R2_PUBLIC_BASE_URL') ?? '').replace(/\/+$/, '');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const PRESIGN_EXPIRY_SECONDS = 600;
const MAX_FILES_PER_REQUEST = 20;

// products/<name>.jpg | logos/<name>.jpg | qrs/<name>.jpg — client-generated
// names are `${Date.now()}-<random>[-thumb].jpg`, hence the narrow charset.
const KEY_PATTERN = /^(products|logos|qrs)\/[a-z0-9][a-z0-9-]*\.jpg$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// --- AWS Signature Version 4 (R2 is S3-compatible, region is always 'auto') ---

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

async function signingKey(dateStamp: string): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${R2_SECRET_ACCESS_KEY}`), dateStamp);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Presigned PUT URL: host is the only signed header, so the client may set
 *  Content-Type / Cache-Control freely (R2 stores them as object metadata). */
async function presignPut(key: string): Promise<string> {
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${R2_BUCKET}/${key}`;
  const { amzDate, dateStamp } = amzDates(new Date());
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const params: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${R2_ACCESS_KEY_ID}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(PRESIGN_EXPIRY_SECONDS)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    'PUT',
    path,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = toHex(await hmac(await signingKey(dateStamp), stringToSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Server-side signed DELETE (header auth, empty payload). */
async function deleteObject(key: string): Promise<boolean> {
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${R2_BUCKET}/${key}`;
  const { amzDate, dateStamp } = amzDates(new Date());
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const payloadHash = await sha256Hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['DELETE', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = toHex(await hmac(await signingKey(dateStamp), stringToSign));
  const res = await fetch(`https://${host}${path}`, {
    method: 'DELETE',
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  // S3 returns 204 on success and on already-missing keys; both are fine.
  return res.ok || res.status === 204;
}

// --- auth ----------------------------------------------------------------------

/** Returns null when the caller is a signed-in admin, else the error response. */
async function requireAdmin(req: Request): Promise<Response | null> {
  const token = (req.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '').trim();
  if (!token) return json({ error: 'sign in required' }, 401);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return json({ error: 'invalid session' }, 401);
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .maybeSingle();
  if (profile?.role !== 'admin' && profile?.role !== 'super_admin') {
    return json({ error: 'admins only' }, 403);
  }
  return null;
}

// --- entry point -----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE_URL) {
    console.error('R2 secrets are not configured');
    return json({ error: 'image storage not configured' }, 500);
  }

  const authError = await requireAdmin(req);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'sign') {
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0 || files.length > MAX_FILES_PER_REQUEST) {
      return json({ error: `files must contain 1-${MAX_FILES_PER_REQUEST} entries` }, 400);
    }
    const keys: string[] = [];
    for (const f of files) {
      const key = typeof f === 'object' && f !== null ? (f as Record<string, unknown>).key : null;
      if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
        return json({ error: 'each file needs a valid key (products|logos|qrs)/<name>.jpg' }, 400);
      }
      keys.push(key);
    }
    const uploads = await Promise.all(
      keys.map(async (key) => ({
        key,
        uploadUrl: await presignPut(key),
        publicUrl: `${R2_PUBLIC_BASE_URL}/${key}`,
      }))
    );
    return json({ uploads });
  }

  if (body.action === 'delete') {
    const keysRaw = Array.isArray(body.keys) ? body.keys : [];
    if (keysRaw.length === 0 || keysRaw.length > 50) {
      return json({ error: 'keys must contain 1-50 entries' }, 400);
    }
    const keys: string[] = [];
    for (const k of keysRaw) {
      if (typeof k !== 'string' || !KEY_PATTERN.test(k)) {
        return json({ error: 'invalid key' }, 400);
      }
      keys.push(k);
    }
    const results = await Promise.all(keys.map((key) => deleteObject(key)));
    const failed = keys.filter((_, i) => !results[i]);
    if (failed.length > 0) console.error('R2 deletes failed:', failed);
    return json({ deleted: keys.length - failed.length, failed });
  }

  return json({ error: 'unknown action' }, 400);
});
