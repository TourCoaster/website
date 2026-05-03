export type Bindings = {
  DB: D1Database;
  SESSIONS: KVNamespace;
  FLAGS: KVNamespace;
  MEDIA: R2Bucket;
  ENVIRONMENT: string;
  PUBLIC_SITE_ORIGIN: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
};

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

export type Variables = {
  requestId: string;
  accessClaims: AccessClaims;
  user: User;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
