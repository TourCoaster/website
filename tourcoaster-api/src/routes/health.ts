import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const healthRoute = new Hono<AppEnv>().get('/', (c) => {
  return c.json({
    ok: true,
    time: new Date().toISOString(),
    environment: c.env.ENVIRONMENT,
    requestId: c.get('requestId'),
  });
});
