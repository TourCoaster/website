import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestId } from './middleware/request-id';
import { healthRoute } from './routes/health';
import { logoutRoute, meRoute, roleRoute } from './routes/me';
import {
  guidesHtmlRoute,
  guidesMeRoute,
  guidesPublicRoute,
  mediaRoute,
} from './routes/guides';
import {
  toursHtmlRoute,
  toursListRoute,
  toursMineRoute,
  toursReadByIdRoute,
  toursWriteRoute,
} from './routes/tours';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', requestId());
app.use('*', corsMiddleware());

app.onError(errorHandler);
app.notFound(notFoundHandler);

// Each sub-router self-protects (or doesn't). Public sub-routers carry no
// auth middleware; protected sub-routers self-apply requireAccessAuth().
const v1 = new Hono<AppEnv>();
v1.route('/health', healthRoute);
v1.route('/auth/logout', logoutRoute);
v1.route('/media', mediaRoute);
v1.route('/me', meRoute);
v1.route('/auth/role', roleRoute);

// Protected guide routes. Mounted before /guides/:slug to avoid shadowing.
v1.route('/guides/me', guidesMeRoute);
v1.route('/guides', guidesPublicRoute);

// Tours: protected /mine before public listing; protected resource writes
// share the same /tours mount, so the writeRouter handles POST/PATCH/DELETE
// on /tours and /tours/:id*. Order matters — register writeRouter (which
// covers POST /, PATCH /:id, DELETE /:id, POST /:id/publish, POST /:id/media)
// BEFORE the public listing/read routes so its protected handlers win.
v1.route('/tours/mine', toursMineRoute);
v1.route('/tours', toursWriteRoute);
v1.route('/tours', toursReadByIdRoute);
v1.route('/tours', toursListRoute);

app.route('/v1', v1);

// Public server-rendered pages. In production a Workers Route on
// tourcoaster.com/{guides,tours}/* hits these handlers and overrides the
// static Jekyll output for those paths.
app.route('/guides', guidesHtmlRoute);
app.route('/tours', toursHtmlRoute);

app.get('/', (c) =>
  c.json({
    name: 'tourcoaster-api',
    version: '0.1.0',
    docs: 'https://github.com/tourcoaster/tourcoaster-api#readme',
  })
);

export default app;
