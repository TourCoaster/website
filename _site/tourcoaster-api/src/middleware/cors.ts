import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

const STATIC_ALLOWED = new Set([
  'https://tourcoaster.com',
  'https://www.tourcoaster.com',
  'http://localhost:5000',
  'http://0.0.0.0:5000',
]);

export const corsMiddleware = (): MiddlewareHandler<AppEnv> =>
  cors({
    origin: (origin, c) => {
      if (!origin) return null;
      if (STATIC_ALLOWED.has(origin)) return origin;
      const dynamic = c.env.PUBLIC_SITE_ORIGIN;
      if (dynamic && origin === dynamic) return origin;
      return null;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'CF-Access-Jwt-Assertion'],
    exposeHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 600,
  });
