import type { AccessClaims, Bindings, Role, User } from '../types';

const nowIso = () => new Date().toISOString();

const rowToUser = (row: Record<string, unknown>): User => ({
  id: String(row.id),
  email: String(row.email),
  google_sub: row.google_sub == null ? null : String(row.google_sub),
  role: (row.role as Role | null) ?? null,
  status: (row.status as 'active' | 'suspended') ?? 'active',
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
});

/**
 * Look up a user by email; create them if missing. Returns the canonical
 * row. Called from the Access auth middleware on every authenticated
 * request — must be cheap on the hot path.
 *
 * `claims.sub` is Cloudflare Access's stable user identifier; we keep it
 * in `google_sub` because in our setup Google is the only IdP.
 */
export const upsertUserFromAccess = async (env: Bindings, claims: AccessClaims): Promise<User> => {
  const email = claims.email.toLowerCase();

  const existing = await env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<Record<string, unknown>>();

  if (existing) {
    if (existing.google_sub !== claims.sub) {
      const now = nowIso();
      await env.DB.prepare('UPDATE users SET google_sub = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(claims.sub, now, existing.id)
        .run();
      existing.google_sub = claims.sub;
      existing.updated_at = now;
    }
    return rowToUser(existing);
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO users (id, email, google_sub, role, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, 'active', ?4, ?4)`
  )
    .bind(id, email, claims.sub, now)
    .run();

  return {
    id,
    email,
    google_sub: claims.sub,
    role: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
};

export const getUserById = async (env: Bindings, id: string): Promise<User | null> => {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowToUser(row) : null;
};
