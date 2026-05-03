import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, Role } from '../types';
import { AppError } from '../middleware/error';
import { verifyAccessJwt } from './jwks';
import { upsertUserFromAccess } from './provision';

const extractToken = (header: string | undefined, cookie: string | undefined): string | null => {
  if (header) return header;
  if (cookie) return cookie;
  return null;
};

/**
 * Verifies the Cloudflare Access JWT on every request, upserts the user,
 * and attaches `accessClaims` and `user` to the Hono context. Mount on any
 * subrouter that should be protected.
 */
export const requireAccessAuth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const headerToken = c.req.header('Cf-Access-Jwt-Assertion');
  const cookieToken = getCookie(c, 'CF_Authorization');
  const token = extractToken(headerToken, cookieToken);

  if (!token) {
    throw new AppError(401, 'unauthenticated', 'Missing Cloudflare Access JWT.');
  }

  const claims = await verifyAccessJwt(token, c.env);
  const user = await upsertUserFromAccess(c.env, claims);

  if (user.status === 'suspended') {
    throw new AppError(403, 'account_suspended', 'This account is suspended.');
  }

  c.set('accessClaims', claims);
  c.set('user', user);
  await next();
};

/**
 * Gate a route on a specific role. Use after `requireAccessAuth()`.
 * Roles: 'traveler' | 'guide' | 'admin'. 'admin' can act as any role.
 */
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = c.get('user');
  if (!user) {
    throw new AppError(401, 'unauthenticated', 'Authentication required.');
  }
  if (user.role === null) {
    throw new AppError(403, 'role_required', 'Pick a role before accessing this route.');
  }
  if (user.role === 'admin') {
    await next();
    return;
  }
  if (!roles.includes(user.role)) {
    throw new AppError(403, 'forbidden', `Requires one of: ${roles.join(', ')}.`);
  }
  await next();
};
