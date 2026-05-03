import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import type { AccessClaims, Bindings } from '../types';
import { AppError } from '../middleware/error';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const getJwks = (teamDomain: string) => {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    jwksCache.set(url, jwks);
  }
  return jwks;
};

const isAccessClaims = (p: JWTPayload): p is JWTPayload & AccessClaims =>
  typeof p.sub === 'string' && typeof p.email === 'string';

export const verifyAccessJwt = async (token: string, env: Bindings): Promise<AccessClaims> => {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new AppError(500, 'access_not_configured', 'Cloudflare Access is not configured on the API.');
  }

  const expectedIssuer = `https://${env.CF_ACCESS_TEAM_DOMAIN}`;
  const jwks = getJwks(env.CF_ACCESS_TEAM_DOMAIN);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer,
      audience: env.CF_ACCESS_AUD,
      algorithms: ['RS256'],
    });
    if (!isAccessClaims(payload)) {
      throw new AppError(401, 'invalid_token', 'Access JWT is missing required claims.');
    }
    return payload as AccessClaims;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'invalid_token', 'Access JWT verification failed.');
  }
};
