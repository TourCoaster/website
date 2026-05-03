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
import { toursHtmlRoute, toursRoute } from './routes/tours';
import { billingRoute } from './routes/billing';
import { checkoutRoute } from './routes/checkout';
import { webhooksRoute } from './routes/webhooks';
import { streamsRoute } from './routes/streams';
import { streamWebhooksRoute } from './routes/stream-webhooks';
import { watchRoute } from './routes/watch';
import { speedtestRoute } from './routes/speedtest';
import type { AppEnv } from './types';

export { LiveTourRoom } from './stream/durable';

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

// Tours: a single router with per-route auth. Public GET /tours and GET
// /tours/:id reach their handlers without traversing guide-only middleware.
v1.route('/tours', toursRoute);

// Stripe surfaces. /webhooks/stripe is unauthenticated (signature-verified
// in-handler); /billing/* and /checkout/* self-apply requireAccessAuth.
v1.route('/billing', billingRoute);
v1.route('/checkout', checkoutRoute);
v1.route('/webhooks', webhooksRoute);

// Cloudflare Stream surfaces. /streams/* self-applies requireAccessAuth;
// /webhooks/stream is unauthenticated (signature-verified in-handler).
v1.route('/streams', streamsRoute);
v1.route('/webhooks/stream', streamWebhooksRoute);
v1.route('/speedtest', speedtestRoute);

app.route('/v1', v1);

// Public server-rendered pages. In production a Workers Route on
// tourcoaster.com/{guides,tours}/* hits these handlers and overrides the
// static Jekyll output for those paths.
app.route('/guides', guidesHtmlRoute);
app.route('/tours', toursHtmlRoute);
app.route('/watch', watchRoute);

app.get('/', (c) =>
  c.json({
    name: 'tourcoaster-api',
    version: '0.1.0',
    docs: 'https://github.com/tourcoaster/tourcoaster-api#readme',
  })
);

export default app;
