import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestId } from './middleware/request-id';
import { healthRoute } from './routes/health';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', requestId());
app.use('*', corsMiddleware());

app.onError(errorHandler);
app.notFound(notFoundHandler);

const v1 = new Hono<AppEnv>();
v1.route('/health', healthRoute);

app.route('/v1', v1);

app.get('/', (c) =>
  c.json({
    name: 'tourcoaster-api',
    version: '0.1.0',
    docs: 'https://github.com/tourcoaster/tourcoaster-api#readme',
  })
);

export default app;
