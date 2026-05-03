export type Bindings = {
  DB: D1Database;
  SESSIONS: KVNamespace;
  FLAGS: KVNamespace;
  MEDIA: R2Bucket;
  ENVIRONMENT: string;
  PUBLIC_SITE_ORIGIN: string;
};

export type Variables = {
  requestId: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
