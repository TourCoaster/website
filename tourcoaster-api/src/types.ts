export type Bindings = {
  DB: D1Database;
  SESSIONS: KVNamespace;
  FLAGS: KVNamespace;
  MEDIA: R2Bucket;
  ENVIRONMENT: string;
  PUBLIC_SITE_ORIGIN: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_BASE: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // Stripe — set as Worker secrets in production. Optional at the type level
  // so tests/dev can boot without payments configured; routes that need them
  // throw a 503 'stripe_not_configured' if missing.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_EXPLORER?: string;
  STRIPE_PRICE_WANDERER?: string;
  // Platform fee in basis points (1500 = 15%). Defaults to 1500 if unset.
  PLATFORM_FEE_BPS?: string;
  // Cloudflare Stream — secrets via `wrangler secret put`. CF_ACCOUNT_ID and
  // STREAM_CUSTOMER_CODE are non-secret config; STREAM_SIGNING_PEM holds the
  // PKCS#8 private key that signs HLS playback JWTs (RS256).
  CF_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  STREAM_WEBHOOK_SECRET?: string;
  STREAM_SIGNING_KEY_ID?: string;
  STREAM_SIGNING_PEM?: string;
  STREAM_KEY_SECRET?: string;
  STREAM_CUSTOMER_CODE?: string;
  // IndexNow key issued by Bing/Yandex; also served as `${key}.txt` for
  // ownership verification. Optional — when unset the cron is a no-op.
  INDEXNOW_KEY?: string;
  // Durable Object that fans out viewer count + chat for one live stream.
  LIVE_ROOMS: DurableObjectNamespace;
};

export type Plan = 'explorer' | 'wanderer';

export type Role = 'traveler' | 'guide' | 'admin';

export type AccessClaims = {
  sub: string;
  email: string;
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  identity_nonce?: string;
};

export type User = {
  id: string;
  email: string;
  google_sub: string | null;
  role: Role | null;
  status: 'active' | 'suspended';
  created_at: string;
  updated_at: string;
};

export type GuideProfile = {
  user_id: string;
  slug: string;
  display_name: string | null;
  bio: string | null;
  location: string | null;
  languages: string[];
  avatar_key: string | null;
  status: 'pending' | 'approved' | 'rejected';
  charges_enabled: boolean;
  email?: string;
  created_at: string;
  updated_at: string;
};

export type Variables = {
  requestId: string;
  accessClaims: AccessClaims;
  user: User;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
