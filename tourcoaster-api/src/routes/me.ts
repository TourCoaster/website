import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { AppEnv, Role } from '../types';
import { AppError } from '../middleware/error';

const slugifyEmail = (email: string): string => {
  const local = email.split('@')[0] ?? 'guide';
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return base.length > 0 ? base : 'guide';
};

const uniqueGuideSlug = async (env: AppEnv['Bindings'], baseEmail: string): Promise<string> => {
  const base = slugifyEmail(baseEmail);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await env.DB.prepare(
      'SELECT 1 AS x FROM guide_profiles WHERE slug = ?1 LIMIT 1'
    )
      .bind(candidate)
      .first<{ x: number }>();
    if (!existing) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
};

export const meRoute = new Hono<AppEnv>().get('/', async (c) => {
  const user = c.get('user');

  let profile: Record<string, unknown> | null = null;
  if (user.role === 'guide') {
    const row = await c.env.DB.prepare(
      `SELECT user_id, slug, display_name, bio, location, languages, avatar_key,
              status, charges_enabled
         FROM guide_profiles WHERE user_id = ?1`
    )
      .bind(user.id)
      .first<Record<string, unknown>>();
    profile = row ?? null;
  }

  return c.json({
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    profile,
  });
});

const ROLE_VALUES: ReadonlyArray<Role> = ['traveler', 'guide'];

export const roleRoute = new Hono<AppEnv>().post('/', async (c) => {
  const user = c.get('user');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }

  const role = (body as { role?: unknown })?.role;
  if (typeof role !== 'string' || !ROLE_VALUES.includes(role as Role)) {
    throw new AppError(422, 'invalid_role', "Role must be 'traveler' or 'guide'.");
  }

  if (user.role !== null) {
    throw new AppError(409, 'role_already_set', 'Role has already been set on this account.');
  }

  const now = new Date().toISOString();
  const chosen = role as Role;

  if (chosen === 'guide') {
    const slug = await uniqueGuideSlug(c.env, user.email);
    const stmts = [
      c.env.DB.prepare(
        'UPDATE users SET role = ?1, updated_at = ?2 WHERE id = ?3 AND role IS NULL'
      ).bind(chosen, now, user.id),
      c.env.DB.prepare(
        `INSERT INTO guide_profiles (user_id, slug, status, charges_enabled, created_at, updated_at)
         VALUES (?1, ?2, 'pending', 0, ?3, ?3)`
      ).bind(user.id, slug, now),
    ];
    const results = await c.env.DB.batch(stmts);
    if (!results[0]?.meta || results[0].meta.changes === 0) {
      throw new AppError(409, 'role_already_set', 'Role has already been set on this account.');
    }
  } else {
    const res = await c.env.DB.prepare(
      'UPDATE users SET role = ?1, updated_at = ?2 WHERE id = ?3 AND role IS NULL'
    )
      .bind(chosen, now, user.id)
      .run();
    if (res.meta.changes === 0) {
      throw new AppError(409, 'role_already_set', 'Role has already been set on this account.');
    }
  }

  return c.json({ ok: true, role: chosen });
});

export const logoutRoute = new Hono<AppEnv>().post('/', (c) => {
  // Clear Cloudflare Access cookies on this origin. The frontend should
  // additionally redirect the user to:
  //   https://<team>.cloudflareaccess.com/cdn-cgi/access/logout
  // to terminate the Access session globally.
  for (const name of ['CF_Authorization', 'CF_AppSession']) {
    deleteCookie(c, name, { path: '/', secure: true, sameSite: 'Lax' });
  }
  return c.body(null, 204);
});
