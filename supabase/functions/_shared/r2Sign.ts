// Shared Cloudflare R2 SigV4 helpers for edge functions (Deno).
// R2 is S3-compatible; region is always 'auto'. Extracted from
// r2-upload-sign so the verification + notify functions can presign
// reads from the PRIVATE proofs bucket without duplicating crypto.
//
// Two buckets:
//   R2_BUCKET        public display images (img.timor.et)
//   R2_PROOFS_BUCKET private payment proofs — presigned access only

export const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID') ?? '';
export const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? '';
export const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? '';
export const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? 'timor-shop-images';
export const R2_PROOFS_BUCKET = Deno.env.get('R2_PROOFS_BUCKET') ?? 'timor-shop-proofs';

export function r2Configured(): boolean {
  return Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

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

/** Presigned GET/PUT URL: host is the only signed header, so the caller may
 *  set Content-Type / Cache-Control freely on PUT (R2 stores them as object
 *  metadata). */
export async function presign(
  method: 'GET' | 'PUT',
  bucket: string,
  key: string,
  expiresSeconds: number
): Promise<string> {
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key}`;
  const { amzDate, dateStamp } = amzDates(new Date());
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const params: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${R2_ACCESS_KEY_ID}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    method,
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

/** Server-side signed request with header auth (empty payload) — for HEAD
 *  existence checks and DELETEs. Returns the raw fetch Response. */
export async function signedRequest(method: string, bucket: string, key: string): Promise<Response> {
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key}`;
  const { amzDate, dateStamp } = amzDates(new Date());
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const payloadHash = await sha256Hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = toHex(await hmac(await signingKey(dateStamp), stringToSign));
  return fetch(`https://${host}${path}`, {
    method,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}
