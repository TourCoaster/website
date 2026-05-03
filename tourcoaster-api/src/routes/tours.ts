import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { AppError } from '../middleware/error';
import { requireAccessAuth, requireRole } from '../auth/middleware';
import { verifyAccessJwt } from '../auth/jwks';
import { presignPut } from '../r2/presign';
import { renderTourPage } from '../render/tour-html';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const ALLOWED_CATEGORIES = ['nature', 'city', 'food', 'history', 'adventure', 'other'] as const;
const ALLOWED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY']);

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 56) || 'tour';

type TourRow = Record<string, unknown>;

type Tour = {
  id: string;
  owner_id: string;
  slug: string;
  title: string;
  description: string | null;
  location: string | null;
  category: string | null;
  duration_minutes: number | null;
  capacity: number | null;
  price_cents: number;
  currency: string;
  vr_enabled: boolean;
  scheduled_at: string | null;
  status: 'draft' | 'published' | 'deleted';
  published_at: string | null;
  created_at: string;
  updated_at: string;
  media: Array<{ id: string; r2_key: string; kind: 'image' | 'video'; position: number }>;
  guide?: {
    user_id: string;
    slug: string;
    display_name: string | null;
    avatar_key: string | null;
    location: string | null;
  } | null;
};

const rowToTour = (row: TourRow): Omit<Tour, 'media' | 'guide'> => ({
  id: String(row.id),
  owner_id: String(row.owner_id),
  slug: String(row.slug),
  title: String(row.title),
  description: row.description == null ? null : String(row.description),
  location: row.location == null ? null : String(row.location),
  category: row.category == null ? null : String(row.category),
  duration_minutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
  capacity: row.capacity == null ? null : Number(row.capacity),
  price_cents: Number(row.price_cents ?? 0),
  currency: String(row.currency ?? 'USD'),
  vr_enabled: row.vr_enabled === 1 || row.vr_enabled === true,
  scheduled_at: row.scheduled_at == null ? null : String(row.scheduled_at),
  status: (row.status as Tour['status']) ?? 'draft',
  published_at: row.published_at == null ? null : String(row.published_at),
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
});

const fetchMedia = async (
  env: AppEnv['Bindings'],
  tourId: string
): Promise<Tour['media']> => {
  const res = await env.DB.prepare(
    `SELECT id, r2_key, kind, position FROM tour_media
     WHERE tour_id = ?1 ORDER BY position ASC, created_at ASC`
  )
    .bind(tourId)
    .all<{ id: string; r2_key: string; kind: 'image' | 'video'; position: number }>();
  return res.results ?? [];
};

const fetchGuide = async (
  env: AppEnv['Bindings'],
  ownerId: string
): Promise<Tour['guide']> => {
  const row = await env.DB.prepare(
    `SELECT user_id, slug, display_name, avatar_key, location FROM guide_profiles
     WHERE user_id = ?1`
  )
    .bind(ownerId)
    .first<{
      user_id: string;
      slug: string;
      display_name: string | null;
      avatar_key: string | null;
      location: string | null;
    }>();
  return row ?? null;
};

const hydrate = async (
  env: AppEnv['Bindings'],
  base: Omit<Tour, 'media' | 'guide'>
): Promise<Tour> => {
  const [media, guide] = await Promise.all([fetchMedia(env, base.id), fetchGuide(env, base.owner_id)]);
  return { ...base, media, guide };
};

const ownerCheck = async (
  env: AppEnv['Bindings'],
  id: string,
  userId: string
): Promise<Omit<Tour, 'media' | 'guide'>> => {
  const row = await env.DB.prepare('SELECT * FROM tours WHERE id = ?1').bind(id).first<TourRow>();
  if (!row) throw new AppError(404, 'tour_not_found', 'Tour not found.');
  const tour = rowToTour(row);
  if (tour.owner_id !== userId) throw new AppError(403, 'not_owner', 'You do not own this tour.');
  return tour;
};

/**
 * Resolve the calling user's `users.id` from either the Cf-Access-Jwt-Assertion
 * header or the CF_Authorization cookie, using the same verifier as
 * requireAccessAuth(). Returns null when no token is present or the token is
 * invalid — the caller decides how to react. Used by GET /:id so unauthenticated
 * traffic can still hit the public path.
 */
const resolveCallerId = async (c: {
  req: { header: (k: string) => string | undefined; raw: Request };
  env: AppEnv['Bindings'];
}): Promise<string | null> => {
  const header = c.req.header('Cf-Access-Jwt-Assertion');
  // Hono's getCookie is exposed off the context; reproduce its lookup here so
  // this helper can be called from outside a middleware closure.
  const cookieHeader = c.req.header('cookie') ?? '';
  let cookieToken: string | undefined;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === 'CF_Authorization') {
      cookieToken = decodeURIComponent(part.slice(eq + 1));
      break;
    }
  }
  const token = header ?? cookieToken;
  if (!token) return null;
  let claims;
  try {
    claims = await verifyAccessJwt(token, c.env);
  } catch {
    return null;
  }
  const userRow = await c.env.DB.prepare(
    'SELECT id FROM users WHERE google_sub = ?1 LIMIT 1'
  )
    .bind(claims.sub)
    .first<{ id: string }>();
  return userRow?.id ?? null;
};

const validatePatch = (
  body: Record<string, unknown>
): { sets: string[]; values: unknown[] } => {
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = ?${values.length + 1}`);
    values.push(val);
  };

  if ('title' in body) {
    const v = body.title;
    if (typeof v !== 'string' || v.trim().length < 3 || v.length > 120) {
      throw new AppError(422, 'invalid_title', 'title must be 3–120 chars.');
    }
    set('title', v.trim());
  }
  if ('description' in body) {
    const v = body.description;
    if (v != null && (typeof v !== 'string' || v.length > 8000)) {
      throw new AppError(422, 'invalid_description', 'description must be ≤ 8000 chars.');
    }
    set('description', v == null ? null : v);
  }
  if ('location' in body) {
    const v = body.location;
    if (v != null && (typeof v !== 'string' || v.length > 160)) {
      throw new AppError(422, 'invalid_location', 'location must be ≤ 160 chars.');
    }
    set('location', v == null ? null : (v as string).trim());
  }
  if ('category' in body) {
    const v = body.category;
    if (v != null && (typeof v !== 'string' || !ALLOWED_CATEGORIES.includes(v as never))) {
      throw new AppError(
        422,
        'invalid_category',
        `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}.`
      );
    }
    set('category', v == null ? null : v);
  }
  if ('duration_minutes' in body) {
    const v = body.duration_minutes;
    if (v != null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 60 * 24 * 30)) {
      throw new AppError(422, 'invalid_duration', 'duration_minutes must be a positive integer.');
    }
    set('duration_minutes', v == null ? null : v);
  }
  if ('capacity' in body) {
    const v = body.capacity;
    if (v != null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10000)) {
      throw new AppError(422, 'invalid_capacity', 'capacity must be a positive integer.');
    }
    set('capacity', v == null ? null : v);
  }
  if ('price_cents' in body) {
    const v = body.price_cents;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100_000_00) {
      throw new AppError(422, 'invalid_price', 'price_cents must be a non-negative integer ≤ 10000000.');
    }
    set('price_cents', v);
  }
  if ('currency' in body) {
    const v = body.currency;
    if (typeof v !== 'string' || !ALLOWED_CURRENCIES.has(v.toUpperCase())) {
      throw new AppError(422, 'invalid_currency', 'currency must be a supported ISO code.');
    }
    set('currency', v.toUpperCase());
  }
  if ('vr_enabled' in body) {
    const v = body.vr_enabled;
    if (typeof v !== 'boolean') {
      throw new AppError(422, 'invalid_vr_enabled', 'vr_enabled must be a boolean.');
    }
    set('vr_enabled', v ? 1 : 0);
  }
  if ('scheduled_at' in body) {
    const v = body.scheduled_at;
    if (v != null) {
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
        throw new AppError(422, 'invalid_scheduled_at', 'scheduled_at must be ISO-8601.');
      }
    }
    set('scheduled_at', v == null ? null : v);
  }
  if ('slug' in body) {
    const v = body.slug;
    if (typeof v !== 'string' || !SLUG_RE.test(v)) {
      throw new AppError(422, 'invalid_slug', 'slug must be 1–60 chars, [a-z0-9-].');
    }
    set('slug', v);
  }
  return { sets, values };
};

// ----------------------------------------------------------------------------
// Single tours router. Auth is applied per-route inline so public GETs reach
// their handlers without traversing guide-only middleware.
// ----------------------------------------------------------------------------

const protectGuide = [requireAccessAuth(), requireRole('guide')] as const;
export const toursRoute = new Hono<AppEnv>();

// Owner-scoped listing. Specific path declared before /:id to avoid /:id
// matching "mine".
toursRoute.get('/mine', ...protectGuide, async (c) => {
  const user = c.get('user');
  const res = await c.env.DB.prepare(
    `SELECT * FROM tours WHERE owner_id = ?1 AND status != 'deleted'
     ORDER BY updated_at DESC LIMIT 200`
  )
    .bind(user.id)
    .all<TourRow>();
  const tours = (res.results ?? []).map(rowToTour);
  return c.json({ tours });
});

toursRoute.post('/', ...protectGuide, async (c) => {
  const user = c.get('user');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < 3 || title.length > 120) {
    throw new AppError(422, 'invalid_title', 'title must be 3–120 chars.');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const baseSlug = slugify(title);

  const candidates: string[] = [baseSlug];
  for (let i = 2; i <= 5; i++) candidates.push(`${baseSlug}-${i}`);
  candidates.push(`${baseSlug}-${crypto.randomUUID().slice(0, 8)}`);

  for (const slug of candidates) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO tours (id, owner_id, slug, title, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?5)`
      )
        .bind(id, user.id, slug, title, now)
        .run();
      const tour = await ownerCheck(c.env, id, user.id);
      return c.json(await hydrate(c.env, tour), 201);
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new AppError(500, 'slug_allocation_failed', 'Could not allocate a tour slug. Try again.');
});

toursRoute.patch('/:id', ...protectGuide, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await ownerCheck(c.env, id, user.id);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }
  const { sets, values } = validatePatch(body);
  if (sets.length === 0) throw new AppError(400, 'no_fields', 'No updatable fields provided.');

  const now = new Date().toISOString();
  sets.push(`updated_at = ?${values.length + 1}`);
  values.push(now);
  values.push(id);

  try {
    await c.env.DB.prepare(`UPDATE tours SET ${sets.join(', ')} WHERE id = ?${values.length}`)
      .bind(...values)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'slug_taken', 'That slug is already taken.');
    }
    throw err;
  }
  const tour = await ownerCheck(c.env, id, user.id);
  return c.json(await hydrate(c.env, tour));
});

toursRoute.post('/:id/publish', ...protectGuide, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const tour = await ownerCheck(c.env, id, user.id);

  const missing: string[] = [];
  if (!tour.title || tour.title.length < 3) missing.push('title');
  if (!tour.description || tour.description.length < 20) missing.push('description');
  if (!tour.location) missing.push('location');
  if (!tour.category) missing.push('category');
  if (!tour.duration_minutes) missing.push('duration_minutes');
  if (tour.price_cents == null) missing.push('price_cents');
  if (missing.length > 0) {
    throw new AppError(
      422,
      'tour_incomplete',
      `Cannot publish: missing or invalid ${missing.join(', ')}.`
    );
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE tours SET status = 'published', published_at = COALESCE(published_at, ?1),
                       updated_at = ?1 WHERE id = ?2`
  )
    .bind(now, id)
    .run();

  const updated = await ownerCheck(c.env, id, user.id);
  return c.json(await hydrate(c.env, updated));
});

toursRoute.delete('/:id', ...protectGuide, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await ownerCheck(c.env, id, user.id);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE tours SET status = 'deleted', updated_at = ?1 WHERE id = ?2`
  )
    .bind(now, id)
    .run();
  return c.body(null, 204);
});

toursRoute.post('/:id/media', ...protectGuide, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await ownerCheck(c.env, id, user.id);

  let body: { contentType?: unknown };
  try {
    body = (await c.req.json()) as { contentType?: unknown };
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }
  const ct = body.contentType;
  if (typeof ct !== 'string' || !ALLOWED_IMAGE_TYPES.has(ct)) {
    throw new AppError(
      422,
      'invalid_content_type',
      'contentType must be image/jpeg, image/png, or image/webp.'
    );
  }
  const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : 'webp';
  const mediaId = crypto.randomUUID();
  const key = `tours/${id}/${mediaId}.${ext}`;
  const uploadUrl = await presignPut(c.env, key, ct, 600);

  const posRow = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM tour_media WHERE tour_id = ?1`
  )
    .bind(id)
    .first<{ next_pos: number }>();
  const position = posRow?.next_pos ?? 0;

  await c.env.DB.prepare(
    `INSERT INTO tour_media (id, tour_id, r2_key, kind, position) VALUES (?1, ?2, ?3, 'image', ?4)`
  )
    .bind(mediaId, id, key, position)
    .run();

  return c.json({ uploadUrl, mediaId, key, contentType: ct, position, maxBytes: MAX_MEDIA_BYTES, expiresIn: 600 });
});

toursRoute.delete('/:id/media/:mediaId', ...protectGuide, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const mediaId = c.req.param('mediaId');
  await ownerCheck(c.env, id, user.id);
  const res = await c.env.DB.prepare(
    `DELETE FROM tour_media WHERE id = ?1 AND tour_id = ?2`
  )
    .bind(mediaId, id)
    .run();
  if (res.meta.changes === 0) throw new AppError(404, 'media_not_found', 'Media not found.');
  return c.body(null, 204);
});

// Public listing.
toursRoute.get('/', async (c) => {
  const url = new URL(c.req.url);
  const category = url.searchParams.get('category');
  const q = url.searchParams.get('q');
  const cursor = url.searchParams.get('cursor');
  const limitParam = parseInt(url.searchParams.get('limit') ?? '24', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 60) : 24;

  const where: string[] = [`status = 'published'`];
  const binds: unknown[] = [];
  if (category && ALLOWED_CATEGORIES.includes(category as never)) {
    binds.push(category);
    where.push(`category = ?${binds.length}`);
  }
  if (q && q.length >= 2 && q.length <= 60) {
    const pat = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
    binds.push(pat, pat);
    where.push(
      `(title LIKE ?${binds.length - 1} ESCAPE '\\' OR description LIKE ?${binds.length} ESCAPE '\\')`
    );
  }
  if (cursor) {
    try {
      const decoded = atob(cursor);
      const [created, id] = decoded.split('|');
      if (!created || !id) throw new Error('bad_cursor');
      binds.push(created, created, id);
      where.push(
        `(created_at < ?${binds.length - 2} OR (created_at = ?${binds.length - 1} AND id < ?${binds.length}))`
      );
    } catch {
      throw new AppError(400, 'invalid_cursor', 'cursor is malformed.');
    }
  }

  binds.push(limit + 1);
  const sql = `SELECT * FROM tours WHERE ${where.join(' AND ')}
               ORDER BY created_at DESC, id DESC LIMIT ?${binds.length}`;
  const res = await c.env.DB.prepare(sql).bind(...binds).all<TourRow>();
  const rows = res.results ?? [];

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    nextCursor = btoa(`${String(last.created_at)}|${String(last.id)}`);
    rows.length = limit;
  }

  const tours = await Promise.all(
    rows.map(async (r) => {
      const t = rowToTour(r);
      const media = await fetchMedia(c.env, t.id);
      return { ...t, cover: media[0]?.r2_key ?? null };
    })
  );

  return c.json({ tours, nextCursor }, 200, {
    'cache-control': 'public, max-age=30, s-maxage=30',
  });
});

// Public-or-owner read by id. Anyone may read a published tour. Drafts are
// readable only by the owner; non-owners get 404 (no draft existence leak).
toursRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM tours WHERE id = ?1').bind(id).first<TourRow>();
  if (!row) throw new AppError(404, 'tour_not_found', 'Tour not found.');
  const tour = rowToTour(row);

  if (tour.status !== 'published') {
    const callerId = await resolveCallerId({ req: c.req, env: c.env });
    if (!callerId || callerId !== tour.owner_id) {
      throw new AppError(404, 'tour_not_found', 'Tour not found.');
    }
  }
  return c.json(await hydrate(c.env, tour));
});

// ----------------------------------------------------------------------------
// Public HTML: /tours/:slug — server-rendered, published only.
// ----------------------------------------------------------------------------

export const toursHtmlRoute = new Hono<AppEnv>().get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await c.env.DB.prepare(
    `SELECT t.* FROM tours t
     JOIN users u ON u.id = t.owner_id
     WHERE t.slug = ?1 AND t.status = 'published' AND u.status = 'active'`
  )
    .bind(slug)
    .first<TourRow>();

  if (!row) {
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Tour not found</title>
       <p>Sorry, that tour does not exist or is not currently published.</p>`,
      404
    );
  }

  const tour = await hydrate(c.env, rowToTour(row));
  const url = new URL(c.req.url);
  const apiBase = url.host.startsWith('api.') ? `${url.protocol}//${url.host}` : 'https://api.tourcoaster.com';
  return c.html(renderTourPage(tour, apiBase), 200, {
    'cache-control': 'no-store',
  });
});
