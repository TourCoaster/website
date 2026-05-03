import { Hono } from 'hono';
import type { AppEnv, GuideProfile } from '../types';
import { AppError } from '../middleware/error';
import { requireRole } from '../auth/middleware';
import { presignPut } from '../r2/presign';
import { renderGuidePage } from '../render/guide-html';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ALLOWED_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

const parseLanguages = (raw: unknown): string[] => {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const rowToProfile = (row: Record<string, unknown>): GuideProfile => ({
  user_id: String(row.user_id),
  slug: String(row.slug),
  display_name: row.display_name == null ? null : String(row.display_name),
  bio: row.bio == null ? null : String(row.bio),
  location: row.location == null ? null : String(row.location),
  languages: parseLanguages(row.languages),
  avatar_key: row.avatar_key == null ? null : String(row.avatar_key),
  status: (row.status as GuideProfile['status']) ?? 'pending',
  charges_enabled: row.charges_enabled === 1 || row.charges_enabled === true,
  email: row.email == null ? undefined : String(row.email),
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
});

// ----------------------------------------------------------------------------
// /v1/guides — protected sub-router (mounted under requireAccessAuth)
// ----------------------------------------------------------------------------

const me = new Hono<AppEnv>();
me.use('*', requireRole('guide'));

me.get('/', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT g.*, u.email FROM guide_profiles g
     JOIN users u ON u.id = g.user_id
     WHERE g.user_id = ?1`
  )
    .bind(user.id)
    .first<Record<string, unknown>>();
  if (!row) throw new AppError(404, 'profile_missing', 'Guide profile not found.');
  return c.json(rowToProfile(row));
});

me.patch('/', async (c) => {
  const user = c.get('user');

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  const set = (col: string, val: unknown) => {
    updates.push(`${col} = ?${values.length + 1}`);
    values.push(val);
  };

  if ('display_name' in body) {
    const v = body.display_name;
    if (v != null && (typeof v !== 'string' || v.length > 80)) {
      throw new AppError(422, 'invalid_display_name', 'display_name must be a string ≤ 80 chars.');
    }
    set('display_name', v == null ? null : (v as string).trim());
  }
  if ('bio' in body) {
    const v = body.bio;
    if (v != null && (typeof v !== 'string' || v.length > 4000)) {
      throw new AppError(422, 'invalid_bio', 'bio must be a string ≤ 4000 chars.');
    }
    set('bio', v == null ? null : (v as string));
  }
  if ('location' in body) {
    const v = body.location;
    if (v != null && (typeof v !== 'string' || v.length > 120)) {
      throw new AppError(422, 'invalid_location', 'location must be a string ≤ 120 chars.');
    }
    set('location', v == null ? null : (v as string).trim());
  }
  if ('languages' in body) {
    const v = body.languages;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new AppError(422, 'invalid_languages', 'languages must be an array of strings.');
    }
    if (v.length > 12) {
      throw new AppError(422, 'invalid_languages', 'At most 12 languages allowed.');
    }
    set('languages', JSON.stringify(v.map((s) => (s as string).trim()).filter(Boolean)));
  }
  if ('slug' in body) {
    const v = body.slug;
    if (typeof v !== 'string' || !SLUG_RE.test(v)) {
      throw new AppError(
        422,
        'invalid_slug',
        'slug must be 1-40 chars, lowercase a-z, 0-9, and dashes (no leading/trailing dash).'
      );
    }
    set('slug', v);
  }
  if ('avatar_key' in body) {
    const v = body.avatar_key;
    if (v !== null && typeof v !== 'string') {
      throw new AppError(422, 'invalid_avatar_key', 'avatar_key must be a string or null.');
    }
    if (typeof v === 'string' && !v.startsWith(`avatars/${user.id}/`)) {
      throw new AppError(422, 'invalid_avatar_key', 'avatar_key must belong to this user.');
    }
    set('avatar_key', v);
  }

  if (updates.length === 0) {
    throw new AppError(400, 'no_fields', 'No updatable fields provided.');
  }

  const now = new Date().toISOString();
  set('updated_at', now);
  values.push(user.id);

  const sql = `UPDATE guide_profiles SET ${updates.join(', ')} WHERE user_id = ?${values.length}`;

  try {
    const res = await c.env.DB.prepare(sql).bind(...values).run();
    if (res.meta.changes === 0) {
      throw new AppError(404, 'profile_missing', 'Guide profile not found.');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'slug_taken', 'That slug is already taken.');
    }
    throw err;
  }

  const row = await c.env.DB.prepare(
    `SELECT g.*, u.email FROM guide_profiles g
     JOIN users u ON u.id = g.user_id
     WHERE g.user_id = ?1`
  )
    .bind(user.id)
    .first<Record<string, unknown>>();
  return c.json(rowToProfile(row!));
});

me.post('/avatar', async (c) => {
  const user = c.get('user');

  let body: { contentType?: unknown };
  try {
    body = (await c.req.json()) as { contentType?: unknown };
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }

  const ct = body.contentType;
  if (typeof ct !== 'string' || !ALLOWED_AVATAR_TYPES.has(ct)) {
    throw new AppError(
      422,
      'invalid_content_type',
      'contentType must be image/jpeg, image/png, or image/webp.'
    );
  }

  const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : 'webp';
  const key = `avatars/${user.id}/${crypto.randomUUID()}.${ext}`;

  const uploadUrl = await presignPut(c.env, key, ct, 600);

  return c.json({
    uploadUrl,
    key,
    contentType: ct,
    maxBytes: MAX_AVATAR_BYTES,
    expiresIn: 600,
  });
});

export const guidesMeRoute = me;

// ----------------------------------------------------------------------------
// /v1/guides/:slug — public JSON (approved only)
// ----------------------------------------------------------------------------

const RESERVED_SLUGS = new Set(['me', 'admin', 'api', 'new']);

export const guidesPublicRoute = new Hono<AppEnv>().get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (RESERVED_SLUGS.has(slug)) {
    throw new AppError(404, 'guide_not_found', 'Guide not found.');
  }
  const row = await c.env.DB.prepare(
    `SELECT g.*, u.email FROM guide_profiles g
     JOIN users u ON u.id = g.user_id
     WHERE g.slug = ?1 AND g.status = 'approved' AND u.status = 'active'`
  )
    .bind(slug)
    .first<Record<string, unknown>>();
  if (!row) throw new AppError(404, 'guide_not_found', 'Guide not found.');
  const profile = rowToProfile(row);
  // Don't leak email on the public endpoint.
  delete profile.email;
  return c.json(profile);
});

// ----------------------------------------------------------------------------
// /guides/:slug — public server-rendered HTML (approved only)
// In production a Workers Route on tourcoaster.com/guides/* sends traffic here.
// ----------------------------------------------------------------------------

export const guidesHtmlRoute = new Hono<AppEnv>().get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await c.env.DB.prepare(
    `SELECT g.*, u.email FROM guide_profiles g
     JOIN users u ON u.id = g.user_id
     WHERE g.slug = ?1 AND g.status = 'approved' AND u.status = 'active'`
  )
    .bind(slug)
    .first<Record<string, unknown>>();

  if (!row) {
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Guide not found</title>
       <p>Sorry, that guide does not exist or is not yet approved.</p>`,
      404
    );
  }

  const profile = rowToProfile(row);
  const url = new URL(c.req.url);
  // The API origin used to fetch avatars — same origin in dev, separate
  // host in production (api.tourcoaster.com).
  const apiBase = url.host.startsWith('api.') ? `${url.protocol}//${url.host}` : 'https://api.tourcoaster.com';

  return c.html(renderGuidePage(profile, apiBase), 200, {
    'cache-control': 'public, max-age=60, s-maxage=300',
  });
});

// ----------------------------------------------------------------------------
// /v1/media/* — public read-through to R2 for avatars and other public media.
// ----------------------------------------------------------------------------

export const mediaRoute = new Hono<AppEnv>().get('/*', async (c) => {
  const path = c.req.path.replace(/^\/v1\/media\//, '');
  if (!path || path.includes('..')) {
    throw new AppError(400, 'invalid_key', 'Bad media key.');
  }
  const obj = await c.env.MEDIA.get(path);
  if (!obj) throw new AppError(404, 'not_found', 'Media not found.');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=86400, immutable');
  return new Response(obj.body, { headers });
});
