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
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', requestId());
app.use('*', corsMiddleware());

app.onError(errorHandler);
app.notFound(notFoundHandler);

// Each sub-router self-protects (or doesn't) — there is no parent wildcard
// auth middleware so registration order cannot accidentally lock out a
// public path. Protected sub-routers are: meRoute, roleRoute, guidesMeRoute.
// Public sub-routers are: healthRoute, logoutRoute, mediaRoute, guidesPublicRoute.
const v1 = new Hono<AppEnv>();
v1.route('/health', healthRoute);
v1.route('/auth/logout', logoutRoute);
v1.route('/media', mediaRoute);
v1.route('/me', meRoute);
v1.route('/auth/role', roleRoute);
// /guides/me MUST be registered before /guides/:slug so the literal beats
// the slug matcher.
v1.route('/guides/me', guidesMeRoute);
v1.route('/guides', guidesPublicRoute);

app.route('/v1', v1);

// Public server-rendered guide pages. In production this Worker is also
// mounted on `tourcoaster.com/guides/*` via a Workers Route in wrangler.toml,
// so requests to https://tourcoaster.com/guides/<slug> hit this handler and
// override the static Jekyll output.
app.route('/guides', guidesHtmlRoute);

app.get('/', (c) =>
  c.json({
    name: 'tourcoaster-api',
    version: '0.1.0',
    docs: 'https://github.com/tourcoaster/tourcoaster-api#readme',
  })
);

export default app;
