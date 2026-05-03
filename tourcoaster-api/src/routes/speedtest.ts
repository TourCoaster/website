import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const speedtestRoute = new Hono<AppEnv>();

const MAX_BYTES = 16 * 1024 * 1024;

speedtestRoute.post('/', async (c) => {
  const body = c.req.raw.body;
  if (body) {
    const reader = body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > MAX_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
  }
  return c.body(null, 204, { 'cache-control': 'no-store' });
});
