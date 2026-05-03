import type { AccessClaims, Bindings, Role, User } from '../types';
import { AppError } from '../middleware/error';

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

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

/**
 * Provision the local `users` row for a Cloudflare Access JWT.
 *
 * Identity model: `google_sub` (the stable Cloudflare Access subject — which
 * in our setup is the Google subject) is the canonical identity key. Email
 * is treated as mutable display/contact data: if Google changes the user's
 * primary email we follow it; we never re-bind a row to a different subject
 * just because the email matches.
 *
 * Resolution order on every authenticated request:
 *   1. Look up by `google_sub`. If found, refresh email if it changed.
 *   2. Otherwise look up by `email`. If a row exists with `google_sub IS
 *      NULL`, claim it (legacy / pre-provisioned account). If a row exists
 *      with a different `google_sub`, that's an identity conflict — return
 *      409 so support can manually merge.
 *   3. Otherwise insert a new row.
 *
 * Concurrency: `users.google_sub` and `users.email` are both UNIQUE in D1.
 * If two requests race on first sight, the loser's INSERT raises a UNIQUE
 * violation and we retry the SELECT.
 */
export const upsertUserFromAccess = async (env: Bindings, claims: AccessClaims): Promise<User> => {
  const sub = claims.sub;
  const email = claims.email.toLowerCase();

  // 1) Stable subject lookup.
  const bySub = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?1')
    .bind(sub)
    .first<Record<string, unknown>>();
  if (bySub) {
    if (String(bySub.email) !== email) {
      const now = nowIso();
      try {
        await env.DB.prepare('UPDATE users SET email = ?1, updated_at = ?2 WHERE id = ?3')
          .bind(email, now, bySub.id)
          .run();
        bySub.email = email;
        bySub.updated_at = now;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError(
            409,
            'identity_conflict',
            'Your email collides with another TourCoaster account. Contact support to merge.'
          );
        }
        throw err;
      }
    }
    return rowToUser(bySub);
  }

  // 2) Email-only lookup — only legitimate when the row was created without
  //    a subject yet (e.g. seeded admin row).
  const byEmail = await env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<Record<string, unknown>>();
  if (byEmail) {
    if (byEmail.google_sub == null) {
      const now = nowIso();
      const res = await env.DB.prepare(
        'UPDATE users SET google_sub = ?1, updated_at = ?2 WHERE id = ?3 AND google_sub IS NULL'
      )
        .bind(sub, now, byEmail.id)
        .run();
      if (res.meta.changes === 0) {
        // Lost a race — re-resolve from scratch.
        return upsertUserFromAccess(env, claims);
      }
      byEmail.google_sub = sub;
      byEmail.updated_at = now;
      return rowToUser(byEmail);
    }
    // Same email, different stable subject — never silently re-bind.
    throw new AppError(
      409,
      'identity_conflict',
      'This email is already linked to a different sign-in identity. Contact support to merge.'
    );
  }

  // 3) Brand-new user.
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, google_sub, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 'active', ?4, ?4)`
    )
      .bind(id, email, sub, now)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Concurrent first-sight from the same user — re-resolve.
      return upsertUserFromAccess(env, claims);
    }
    throw err;
  }

  return {
    id,
    email,
    google_sub: sub,
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
