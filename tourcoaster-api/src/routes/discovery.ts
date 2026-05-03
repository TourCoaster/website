import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const searchRoute = new Hono<AppEnv>();

const escapeLike = (s: string): string => s.replace(/[%_\\]/g, (m) => '\\' + m);

searchRoute.get('/', async (c) => {
  const url = new URL(c.req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 2 || q.length > 60) {
    return c.json({ q, tours: [], guides: [] }, 200, {
      'cache-control': 'public, max-age=60',
    });
  }

  const pat = `%${escapeLike(q)}%`;

  const [tourRes, guideRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id, t.slug, t.title, t.description, t.location, t.category,
              t.vr_enabled, t.updated_at,
              gp.slug AS guide_slug, gp.display_name AS guide_display_name
         FROM tours t
         JOIN users u ON u.id = t.owner_id
         LEFT JOIN guide_profiles gp ON gp.user_id = t.owner_id
        WHERE t.status = 'published'
          AND u.status = 'active'
          AND (
            t.title       LIKE ?1 ESCAPE '\\' OR
            t.description LIKE ?1 ESCAPE '\\' OR
            t.location    LIKE ?1 ESCAPE '\\'
          )
        ORDER BY
          CASE WHEN t.title LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END,
          t.updated_at DESC
        LIMIT 20`
    )
      .bind(pat)
      .all<{
        id: string;
        slug: string;
        title: string;
        description: string | null;
        location: string | null;
        category: string | null;
        vr_enabled: number;
        updated_at: string;
        guide_slug: string | null;
        guide_display_name: string | null;
      }>(),
    c.env.DB.prepare(
      `SELECT gp.slug, gp.display_name, gp.location, gp.bio, gp.avatar_key, gp.updated_at
         FROM guide_profiles gp
         JOIN users u ON u.id = gp.user_id
        WHERE gp.status = 'approved'
          AND u.status = 'active'
          AND (
            gp.display_name LIKE ?1 ESCAPE '\\' OR
            gp.location     LIKE ?1 ESCAPE '\\' OR
            gp.bio          LIKE ?1 ESCAPE '\\'
          )
        ORDER BY
          CASE WHEN gp.display_name LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END,
          gp.updated_at DESC
        LIMIT 20`
    )
      .bind(pat)
      .all<{
        slug: string;
        display_name: string | null;
        location: string | null;
        bio: string | null;
        avatar_key: string | null;
        updated_at: string;
      }>(),
  ]);

  return c.json(
    {
      q,
      tours: tourRes.results ?? [],
      guides: guideRes.results ?? [],
    },
    200,
    { 'cache-control': 'public, max-age=60' }
  );
});

export const sitemapDataRoute = new Hono<AppEnv>();

type SitemapPayload = {
  generated_at: string;
  tours: Array<{
    slug: string;
    title: string;
    location: string | null;
    category: string | null;
    vr_enabled: boolean;
    updated_at: string;
  }>;
  guides: Array<{
    slug: string;
    display_name: string | null;
    location: string | null;
    updated_at: string;
  }>;
};

export const buildSitemapPayload = async (
  env: AppEnv['Bindings']
): Promise<SitemapPayload> => {
  const [tourRes, guideRes] = await Promise.all([
    env.DB.prepare(
      `SELECT t.slug, t.title, t.location, t.category, t.vr_enabled, t.updated_at
         FROM tours t
         JOIN users u ON u.id = t.owner_id
        WHERE t.status = 'published' AND u.status = 'active'
        ORDER BY t.updated_at DESC
        LIMIT 5000`
    ).all<{
      slug: string;
      title: string;
      location: string | null;
      category: string | null;
      vr_enabled: number;
      updated_at: string;
    }>(),
    env.DB.prepare(
      `SELECT gp.slug, gp.display_name, gp.location, gp.updated_at
         FROM guide_profiles gp
         JOIN users u ON u.id = gp.user_id
        WHERE gp.status = 'approved' AND u.status = 'active'
        ORDER BY gp.updated_at DESC
        LIMIT 5000`
    ).all<{
      slug: string;
      display_name: string | null;
      location: string | null;
      updated_at: string;
    }>(),
  ]);

  return {
    generated_at: new Date().toISOString(),
    tours: (tourRes.results ?? []).map((r) => ({
      slug: r.slug,
      title: r.title,
      location: r.location,
      category: r.category,
      vr_enabled: r.vr_enabled === 1,
      updated_at: r.updated_at,
    })),
    guides: guideRes.results ?? [],
  };
};

sitemapDataRoute.get('/', async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/__cache/sitemap-data', c.req.url).toString(), {
    method: 'GET',
  });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const payload = await buildSitemapPayload(c.env);
  const res = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});
