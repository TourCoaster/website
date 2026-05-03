import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestId } from './middleware/request-id';
import { healthRoute } from './routes/health';
import { logoutRoute, meRoute, roleRoute } from './routes/me';
import { requireAccessAuth } from './auth/middleware';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', requestId());
app.use('*', corsMiddleware());

app.onError(errorHandler);
app.notFound(notFoundHandler);

const v1 = new Hono<AppEnv>();
v1.route('/health', healthRoute); // public
v1.route('/auth/logout', logoutRoute); // public, best-effort cookie clear

const protectedRoutes = new Hono<AppEnv>();
protectedRoutes.use('*', requireAccessAuth());
protectedRoutes.route('/me', meRoute);
protectedRoutes.route('/auth/role', roleRoute);

v1.route('/', protectedRoutes);

app.route('/v1', v1);

app.get('/', (c) =>
  c.json({
    name: 'tourcoaster-api',
    version: '0.1.0',
    docs: 'https://github.com/tourcoaster/tourcoaster-api#readme',
  })
);

export default app;
