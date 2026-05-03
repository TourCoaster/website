/**
 * Minimal, fetch-based Stripe client for Cloudflare Workers.
 *
 * We deliberately avoid the `stripe` npm SDK to keep the Worker bundle small
 * and to dodge its Node-specific bits. All calls go through `stripeFetch`,
 * which form-encodes nested params the way Stripe's REST API expects.
 *
 * Webhook signatures are verified with `verifyStripeSignature`, which uses
 * SubtleCrypto HMAC-SHA256 directly.
 */
import type { Bindings } from '../types';
import { AppError } from '../middleware/error';

const STRIPE_API_BASE = 'https://api.stripe.com';
const STRIPE_API_VERSION = '2024-12-18.acacia';

export type StripeFormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StripeForm
  | StripeFormValue[];
export interface StripeForm {
  [key: string]: StripeFormValue;
}

/**
 * Recursively form-encodes nested objects/arrays the way Stripe expects:
 *   { a: { b: 1 } }       -> a[b]=1
 *   { a: [{ x: 1 }] }     -> a[0][x]=1
 *   { a: ['x','y'] }      -> a[0]=x&a[1]=y
 * `null`/`undefined` values are dropped.
 */
export const formEncode = (data: StripeForm, prefix = ''): string => {
  const parts: string[] = [];
  const append = (key: string, val: StripeFormValue) => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((item, i) => append(`${key}[${i}]`, item));
      return;
    }
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val as StripeForm)) {
        append(`${key}[${k}]`, v);
      }
      return;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
  };
  for (const [k, v] of Object.entries(data)) {
    append(prefix ? `${prefix}[${k}]` : k, v);
  }
  return parts.join('&');
};

export type StripeFetchOptions = {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: StripeForm;
  /** Stripe-Account header for acting on a connected account. */
  stripeAccount?: string;
  /** Optional Idempotency-Key — required for any non-trivial POST. */
  idempotencyKey?: string;
};

export const stripeFetch = async <T = Record<string, unknown>>(
  env: Bindings,
  path: string,
  options: StripeFetchOptions = {}
): Promise<T> => {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(503, 'stripe_not_configured', 'Stripe is not configured on this environment.');
  }
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Stripe-Version': STRIPE_API_VERSION,
    Accept: 'application/json',
  };
  let body: string | undefined;
  if (options.body && method !== 'GET') {
    body = formEncode(options.body);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.stripeAccount) headers['Stripe-Account'] = options.stripeAccount;

  const res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errObj = (json.error as Record<string, unknown> | undefined) ?? {};
    const code = String(errObj.code ?? errObj.type ?? 'stripe_error');
    const message = String(errObj.message ?? `Stripe ${method} ${path} failed (${res.status}).`);
    // 4xx from Stripe usually means our request is bad — surface as 502 so
    // ops can spot it. 429 we forward as 429.
    const status = res.status === 429 ? 429 : 502;
    throw new AppError(status, `stripe_${code}`.slice(0, 64), message);
  }
  return json as T;
};

// ---------------------------------------------------------------------------
// Webhook signature verification.
// Header format: `t=<unix>,v1=<hex>[,v1=<hex>...]`
// ---------------------------------------------------------------------------

const hexFromBytes = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
  account?: string;
};

export const verifyStripeSignature = async (
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300
): Promise<StripeEvent> => {
  if (!header) {
    throw new AppError(400, 'missing_signature', 'Missing Stripe-Signature header.');
  }
  const parts = header.split(',').map((p) => p.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 't' && v) timestamp = parseInt(v, 10);
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) {
    throw new AppError(400, 'invalid_signature', 'Stripe-Signature header is malformed.');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSeconds) {
    throw new AppError(400, 'signature_expired', 'Webhook timestamp outside tolerance.');
  }
  const payload = `${timestamp}.${rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = hexFromBytes(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  const ok = signatures.some((s) => constantTimeEquals(s, expected));
  if (!ok) {
    throw new AppError(400, 'invalid_signature', 'Webhook signature did not match.');
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw new AppError(400, 'invalid_body', 'Webhook body is not valid JSON.');
  }
  if (!event.id || !event.type) {
    throw new AppError(400, 'invalid_event', 'Webhook event is missing id/type.');
  }
  return event;
};
