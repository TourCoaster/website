import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';

export class AppError extends HTTPException {
  public readonly code: string;
  constructor(status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500, code: string, message: string) {
    super(status, { message });
    this.code = code;
  }
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');

  if (err instanceof AppError) {
    return c.json(
      {
        error: { code: err.code, message: err.message, requestId },
      },
      err.status
    );
  }

  if (err instanceof HTTPException) {
    return c.json(
      {
        error: { code: 'http_error', message: err.message, requestId },
      },
      err.status
    );
  }

  console.error(`[${requestId}] unhandled error:`, err);
  return c.json(
    {
      error: { code: 'internal_error', message: 'Internal server error.', requestId },
    },
    500
  );
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  return c.json(
    {
      error: {
        code: 'not_found',
        message: `Route ${c.req.method} ${c.req.path} not found.`,
        requestId: c.get('requestId'),
      },
    },
    404
  );
};
