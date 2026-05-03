/**
 * Cloudflare Stream client + helpers.
 *
 * - `streamFetch` talks to the CF API for live-input lifecycle.
 * - `encryptStreamKey` / `decryptStreamKey` AES-GCM-encrypt the live-input
 *   secret so we never store it in plaintext.
 * - `signPlaybackToken` mints a short-lived RS256 JWT used in the signed
 *   HLS playback URL: `https://customer-<id>.cloudflarestream.com/<jwt>/manifest/video.m3u8`.
 * - `verifyStreamWebhookSignature` validates the `Webhook-Signature` header
 *   set by Cloudflare Stream webhooks.
 */
import { importPKCS8, SignJWT } from 'jose';
import type { Bindings } from '../types';
import { AppError } from '../middleware/error';

const STREAM_API_BASE = 'https://api.cloudflare.com';
const KEY_ENC_VERSION = 1;

type CfEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
};

const requireConfig = (env: Bindings): { token: string; account: string } => {
  if (!env.STREAM_API_TOKEN || !env.CF_ACCOUNT_ID) {
    throw new AppError(503, 'stream_not_configured', 'Cloudflare Stream is not configured on this environment.');
  }
  return { token: env.STREAM_API_TOKEN, account: env.CF_ACCOUNT_ID };
};

export const streamFetch = async <T = Record<string, unknown>>(
  env: Bindings,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}
): Promise<T> => {
  const { token, account } = requireConfig(env);
  const method = options.method ?? 'GET';
  const url = `${STREAM_API_BASE}/client/v4/accounts/${account}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body });
  const json = (await res.json().catch(() => ({}))) as CfEnvelope<T>;
  if (!res.ok || json.success === false) {
    const msg = json.errors?.[0]?.message ?? `Stream ${method} ${path} failed (${res.status}).`;
    throw new AppError(res.status === 429 ? 429 : 502, 'stream_error', msg);
  }
  return (json.result ?? ({} as T)) as T;
};

// ---------------------------------------------------------------------------
// Live-input lifecycle.
// ---------------------------------------------------------------------------

export type LiveInput = {
  uid: string;
  rtmps: { url: string; streamKey: string };
  rtmpsPlayback?: { url: string; streamKey: string };
  meta?: Record<string, string>;
  recording?: Record<string, unknown>;
};

export const createLiveInput = async (
  env: Bindings,
  meta: Record<string, string>
): Promise<LiveInput> =>
  streamFetch<LiveInput>(env, '/stream/live_inputs', {
    method: 'POST',
    body: {
      meta,
      // Sign all playback (live + recordings) so URLs are useless after
      // their JWT expires.
      recording: { mode: 'automatic', requireSignedURLs: true, timeoutSeconds: 10 },
    },
  });

export const getLiveInput = (env: Bindings, uid: string): Promise<LiveInput> =>
  streamFetch<LiveInput>(env, `/stream/live_inputs/${encodeURIComponent(uid)}`);

export const deleteLiveInput = (env: Bindings, uid: string): Promise<unknown> =>
  streamFetch(env, `/stream/live_inputs/${encodeURIComponent(uid)}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Stream-key encryption (AES-GCM, key derived from STREAM_KEY_SECRET).
// Storage format: base64(version-byte | iv(12) | ciphertext+tag).
// ---------------------------------------------------------------------------

const importKeySecret = async (secret: string): Promise<CryptoKey> => {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const b64encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64decode = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const encryptStreamKey = async (env: Bindings, plaintext: string): Promise<string> => {
  if (!env.STREAM_KEY_SECRET) {
    throw new AppError(503, 'stream_key_secret_missing', 'STREAM_KEY_SECRET is not configured.');
  }
  const key = await importKeySecret(env.STREAM_KEY_SECRET);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  );
  const out = new Uint8Array(1 + iv.length + cipher.length);
  out[0] = KEY_ENC_VERSION;
  out.set(iv, 1);
  out.set(cipher, 1 + iv.length);
  return b64encode(out);
};

export const decryptStreamKey = async (env: Bindings, blob: string): Promise<string> => {
  if (!env.STREAM_KEY_SECRET) {
    throw new AppError(503, 'stream_key_secret_missing', 'STREAM_KEY_SECRET is not configured.');
  }
  const bytes = b64decode(blob);
  if (bytes.length < 1 + 12 + 16 || bytes[0] !== KEY_ENC_VERSION) {
    throw new AppError(500, 'stream_key_corrupt', 'Stored stream key is corrupted.');
  }
  const key = await importKeySecret(env.STREAM_KEY_SECRET);
  const iv = bytes.slice(1, 13);
  const cipher = bytes.slice(13);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
};

// ---------------------------------------------------------------------------
// Signed-playback JWT for Stream HLS URLs.
// ---------------------------------------------------------------------------

let cachedSigningKey: { pem: string; key: CryptoKey } | null = null;
const getSigningKey = async (env: Bindings): Promise<CryptoKey> => {
  if (!env.STREAM_SIGNING_KEY_ID || !env.STREAM_SIGNING_PEM) {
    throw new AppError(503, 'stream_signing_missing', 'Stream signing key is not configured.');
  }
  if (cachedSigningKey && cachedSigningKey.pem === env.STREAM_SIGNING_PEM) {
    return cachedSigningKey.key;
  }
  const key = await importPKCS8(env.STREAM_SIGNING_PEM, 'RS256');
  cachedSigningKey = { pem: env.STREAM_SIGNING_PEM, key: key as CryptoKey };
  return cachedSigningKey.key;
};

export type PlaybackTokenOptions = {
  /** Live-input or video uid — becomes the JWT subject. */
  uid: string;
  /** Token lifetime in seconds. Default 2 hours. */
  ttlSeconds?: number;
  /** Optional Stream `accessRules` — IP/country gating. */
  accessRules?: Array<Record<string, unknown>>;
};

export const signPlaybackToken = async (
  env: Bindings,
  options: PlaybackTokenOptions
): Promise<{ token: string; expiresAt: number }> => {
  if (!env.STREAM_SIGNING_KEY_ID) {
    throw new AppError(503, 'stream_signing_missing', 'Stream signing key is not configured.');
  }
  const ttl = Math.min(options.ttlSeconds ?? 2 * 60 * 60, 6 * 60 * 60);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const key = await getSigningKey(env);
  const jwt = await new SignJWT({
    sub: options.uid,
    kid: env.STREAM_SIGNING_KEY_ID,
    exp,
    ...(options.accessRules ? { accessRules: options.accessRules } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: env.STREAM_SIGNING_KEY_ID })
    .sign(key);
  return { token: jwt, expiresAt: exp };
};

/**
 * Build the signed HLS manifest URL for a live input or recording.
 * `customerCode` is the `customer-<code>` subdomain CF assigns the account;
 * for our deployment it is exposed via STREAM_CUSTOMER_CODE.
 */
export const buildSignedHlsUrl = (env: Bindings, token: string): string => {
  const code = env.STREAM_CUSTOMER_CODE || 'customer-unknown';
  return `https://${code}.cloudflarestream.com/${token}/manifest/video.m3u8`;
};

// ---------------------------------------------------------------------------
// Stream webhook signature verification.
// CF Stream sends `Webhook-Signature: time=<unix>,sig1=<hex>` (HMAC-SHA256
// over `<time>.<rawBody>` with the configured webhook secret).
// ---------------------------------------------------------------------------

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const hexFromBytes = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const verifyStreamWebhookSignature = async (
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300
): Promise<void> => {
  if (!header) throw new AppError(400, 'missing_signature', 'Missing Webhook-Signature header.');
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=') as [string, string])
  );
  const ts = parseInt(parts.time ?? '', 10);
  const sig = parts.sig1;
  if (!ts || !sig) throw new AppError(400, 'invalid_signature', 'Webhook-Signature is malformed.');
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) {
    throw new AppError(400, 'signature_expired', 'Stream webhook timestamp outside tolerance.');
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = hexFromBytes(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${rawBody}`))
  );
  if (!constantTimeEquals(expected, sig)) {
    throw new AppError(400, 'invalid_signature', 'Stream webhook signature did not match.');
  }
};
