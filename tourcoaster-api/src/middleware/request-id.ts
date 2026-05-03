import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header('cf-ray') ?? c.req.header('x-request-id');
  const id = incoming ?? crypto.randomUUID();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
};
