// Presigned uploads + deletes for Cloudflare R2.
//
// Display images (products/photos, logos, QRs) live in the PUBLIC bucket
// served from https://img.timor.et — admins request presigned PUT URLs and
// upload bytes straight to R2, then store the public URL.
//
// Payment proofs live in the PRIVATE R2_PROOFS_BUCKET (no public access):
//   - sign-proof-upload: anonymous (shoppers aren't signed in), presigned
//     PUT, flat <name>.jpg keys only, max 4 per request.
//   - sign-proof-get:    admin-only, presigned GET. Falls back to a Supabase
//     signed URL for proofs not yet migrated off payment-proofs-private.
//
// verify_jwt is off at the gateway (the app calls this with the user's own
// access token, and OPTIONS must be answered for browsers), so the function
// authenticates the caller itself for the admin actions: bearer token ->
// auth.getUser -> profiles role must be 'admin' or 'super_admin'.
//
// Required secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET, R2_PUBLIC_BASE_URL, R2_PROOFS_BUCKET. SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { R2_BUCKET, R2_PROOFS_BUCKET, presign, r2Configured, signedRequest } from '../_shared/r2Sign.ts';

const R2_PUBLIC_BASE_URL = (Deno.env.get('R2_PUBLIC_BASE_URL') ?? '').replace(/\/+$/, '');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const PRESIGN_EXPIRY_SECONDS = 600;
const MAX_FILES_PER_REQUEST = 20;
const MAX_PROOF_UPLOADS_PER_REQUEST = 4;

// products/<name>.jpg | logos/<name>.jpg | qrs/<name>.jpg — client-generated
// names are `${Date.now()}-<random>[-thumb].jpg`, hence the narrow charset.
const KEY_PATTERN = /^(products|logos|qrs)\/[a-z0-9][a-z0-9-]*\.jpg$/;
// Proof keys are the same flat `${Date.now()}-<random>.jpg` names the client
// has always used (keys did not change with the R2 move).
const PROOF_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*\.jpg$/;

// Supabase bucket that held proofs before the R2 move (transition fallback).
const LEGACY_PROOFS_BUCKET = 'payment-proofs-private';

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

// --- actions ---------------------------------------------------------------------

async function handleSignUploads(body: Record<string, unknown>): Promise<Response> {
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
      uploadUrl: await presign('PUT', R2_BUCKET, key, PRESIGN_EXPIRY_SECONDS),
      publicUrl: `${R2_PUBLIC_BASE_URL}/${key}`,
    }))
  );
  return json({ uploads });
}

async function handleDeletes(body: Record<string, unknown>): Promise<Response> {
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
  const results = await Promise.all(
    keys.map(async (key) => {
      const res = await signedRequest('DELETE', R2_BUCKET, key);
      // S3 returns 204 on success and on already-missing keys; both are fine.
      return res.ok || res.status === 204;
    })
  );
  const failed = keys.filter((_, i) => !results[i]);
  if (failed.length > 0) console.error('R2 deletes failed:', failed);
  return json({ deleted: keys.length - failed.length, failed });
}

/** Anonymous shopper proof uploads. No auth — same exposure as the public-
 *  insert Supabase bucket this replaces, but tighter: pattern-restricted
 *  keys, at most 4 per request, URLs expire in 10 minutes, and the bucket
 *  is private so junk uploads are invisible to everyone. */
async function handleSignProofUpload(body: Record<string, unknown>): Promise<Response> {
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0 || files.length > MAX_PROOF_UPLOADS_PER_REQUEST) {
    return json({ error: `files must contain 1-${MAX_PROOF_UPLOADS_PER_REQUEST} entries` }, 400);
  }
  const keys: string[] = [];
  for (const f of files) {
    const key = typeof f === 'object' && f !== null ? (f as Record<string, unknown>).key : null;
    if (typeof key !== 'string' || !PROOF_KEY_PATTERN.test(key)) {
      return json({ error: 'each file needs a valid flat <name>.jpg key' }, 400);
    }
    keys.push(key);
  }
  const uploads = await Promise.all(
    keys.map(async (key) => ({
      key,
      uploadUrl: await presign('PUT', R2_PROOFS_BUCKET, key, PRESIGN_EXPIRY_SECONDS),
    }))
  );
  return json({ uploads });
}

/** Admin-only proof viewing. Presigns R2 GETs; proofs not yet migrated to R2
 *  fall back to a Supabase signed URL from the legacy bucket. Returns one
 *  entry per requested key (null when the proof exists in neither place). */
async function handleSignProofGet(body: Record<string, unknown>): Promise<Response> {
  const keysRaw = Array.isArray(body.keys) ? body.keys : [];
  if (keysRaw.length === 0 || keysRaw.length > MAX_FILES_PER_REQUEST) {
    return json({ error: `keys must contain 1-${MAX_FILES_PER_REQUEST} entries` }, 400);
  }
  const keys: string[] = [];
  for (const k of keysRaw) {
    if (typeof k !== 'string' || !PROOF_KEY_PATTERN.test(k)) {
      return json({ error: 'invalid key' }, 400);
    }
    keys.push(k);
  }
  const proofs = await Promise.all(
    keys.map(async (key) => {
      const head = await signedRequest('HEAD', R2_PROOFS_BUCKET, key);
      if (head.ok) {
        return { key, url: await presign('GET', R2_PROOFS_BUCKET, key, PRESIGN_EXPIRY_SECONDS) };
      }
      const { data, error } = await supabase.storage
        .from(LEGACY_PROOFS_BUCKET)
        .createSignedUrl(key, 3600);
      if (error) console.error('legacy proof sign failed:', key, error.message ?? error);
      return { key, url: data?.signedUrl ?? null };
    })
  );
  return json({ proofs });
}

// --- entry point -----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!r2Configured() || !R2_PUBLIC_BASE_URL) {
    console.error('R2 secrets are not configured');
    return json({ error: 'image storage not configured' }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const action = typeof body.action === 'string' ? body.action : '';

  // Shopper proof uploads are the only anonymous action.
  if (action !== 'sign-proof-upload') {
    const authError = await requireAdmin(req);
    if (authError) return authError;
  }

  switch (action) {
    case 'sign':
      return handleSignUploads(body);
    case 'delete':
      return handleDeletes(body);
    case 'sign-proof-upload':
      return handleSignProofUpload(body);
    case 'sign-proof-get':
      return handleSignProofGet(body);
    default:
      return json({ error: 'unknown action' }, 400);
  }
});
