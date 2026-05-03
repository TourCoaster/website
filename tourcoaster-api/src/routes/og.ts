import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

// ----------------------------------------------------------------------------
// OG image worker. Mounted at og.tourcoaster.com/* via wrangler routes.
// v1 returns templated SVG with content-type image/svg+xml — Twitter/X,
// LinkedIn, Slack, and Discord all render SVG OG cards. Facebook/Meta still
// prefers raster, so converting to PNG via @resvg/resvg-wasm is tracked as
// follow-up work; the .png paths are aliased to the same SVG body for now.
// ----------------------------------------------------------------------------

export const ogRoute = new Hono<AppEnv>();

const SITE_NAME = 'TourCoaster';
const W = 1200;
const H = 630;

const xml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'
  );

const wrap = (text: string, max: number, lines: number): string[] => {
  const words = (text ?? '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) out.push(cur);
      cur = w;
      if (out.length >= lines) break;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur && out.length < lines) out.push(cur);
  if (out.length === lines && words.length > out.join(' ').split(/\s+/).length) {
    out[out.length - 1] = out[out.length - 1]!.replace(/\s*\S*$/, '') + '…';
  }
  return out;
};

type Card = {
  kind: 'tour' | 'guide' | 'site';
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  badge?: string | null;
};

const renderSvg = (card: Card): string => {
  const titleLines = wrap(card.title, 26, 2);
  const subLines = card.subtitle ? wrap(card.subtitle, 50, 2) : [];
  const titleY = 240;
  const subY = titleY + titleLines.length * 84 + 40;
  const accent = card.kind === 'tour' ? '#16a34a' : card.kind === 'guide' ? '#0ea5e9' : '#16a34a';
  const badge = card.badge ?? (card.kind === 'tour' ? 'Tour' : card.kind === 'guide' ? 'Guide' : '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="100%" stop-color="#0f2a1d"/>
    </linearGradient>
    <style>
      .t { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: #fff; }
      .h { font-weight: 800; font-size: 76px; }
      .s { font-weight: 500; font-size: 36px; fill: #cbd5e1; }
      .m { font-weight: 600; font-size: 28px; fill: #94a3b8; letter-spacing: 2px; text-transform: uppercase; }
      .b { font-weight: 700; font-size: 24px; fill: #fff; letter-spacing: 2px; text-transform: uppercase; }
      .brand { font-weight: 800; font-size: 32px; fill: #fff; letter-spacing: 1px; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="0" y="0" width="14" height="${H}" fill="${accent}"/>
  <g transform="translate(80,80)">
    <circle cx="20" cy="20" r="20" fill="${accent}"/>
    <text x="60" y="30" class="t brand">${xml(SITE_NAME)}</text>
  </g>
  ${
    badge
      ? `<g transform="translate(80,160)"><rect x="0" y="0" width="${badge.length * 16 + 40}" height="44" rx="22" fill="${accent}"/><text x="20" y="30" class="t b">${xml(badge)}</text></g>`
      : ''
  }
  ${titleLines
    .map(
      (line, i) =>
        `<text x="80" y="${titleY + i * 84}" class="t h">${xml(line)}</text>`
    )
    .join('')}
  ${subLines
    .map(
      (line, i) =>
        `<text x="80" y="${subY + i * 46}" class="t s">${xml(line)}</text>`
    )
    .join('')}
  ${
    card.meta
      ? `<text x="80" y="${H - 70}" class="t m">${xml(card.meta)}</text>`
      : ''
  }
</svg>`;
};

const svgResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=86400',
    },
  });

const stripExt = (s: string): string => s.replace(/\.(png|svg|jpg|jpeg|webp)$/i, '');

ogRoute.get('/', (c) =>
  c.text('TourCoaster OG image worker. Try /tour/:id or /guide/:slug.', 200)
);

ogRoute.get('/site.png', () =>
  svgResponse(
    renderSvg({
      kind: 'site',
      title: 'Tours, guides, and live VR — for everyone.',
      subtitle:
        'TourCoaster connects travellers with verified local guides for in-person and immersive VR tours.',
      meta: 'tourcoaster.com',
    })
  )
);

const tourHandler = async (c: Context<AppEnv>) => {
  const idOrSlug = stripExt(c.req.param('id') ?? '');
  const row = await c.env.DB.prepare(
    `SELECT t.title, t.location, t.category, t.vr_enabled,
            gp.display_name AS guide_display_name
       FROM tours t
       JOIN users u ON u.id = t.owner_id
       LEFT JOIN guide_profiles gp ON gp.user_id = t.owner_id
      WHERE (t.id = ?1 OR t.slug = ?1)
        AND t.status = 'published'
        AND u.status = 'active'
      LIMIT 1`
  )
    .bind(idOrSlug)
    .first<{
      title: string;
      location: string | null;
      category: string | null;
      vr_enabled: number;
      guide_display_name: string | null;
    }>();
  if (!row) {
    return svgResponse(
      renderSvg({
        kind: 'site',
        title: 'Tour not found',
        subtitle: 'This tour is no longer available on TourCoaster.',
      })
    );
  }
  const meta = [row.location, row.category].filter(Boolean).join(' · ');
  return svgResponse(
    renderSvg({
      kind: 'tour',
      title: row.title,
      subtitle: row.guide_display_name ? `with ${row.guide_display_name}` : null,
      meta: meta || null,
      badge: row.vr_enabled === 1 ? 'VR Tour' : 'Tour',
    })
  );
};
ogRoute.get('/tour/:id', tourHandler);

const guideHandler = async (c: Context<AppEnv>) => {
  const slug = stripExt(c.req.param('slug') ?? '');
  const row = await c.env.DB.prepare(
    `SELECT gp.display_name, gp.location, gp.bio
       FROM guide_profiles gp
       JOIN users u ON u.id = gp.user_id
      WHERE gp.slug = ?1 AND gp.status = 'approved' AND u.status = 'active'
      LIMIT 1`
  )
    .bind(slug)
    .first<{ display_name: string | null; location: string | null; bio: string | null }>();
  if (!row) {
    return svgResponse(
      renderSvg({
        kind: 'site',
        title: 'Guide not found',
        subtitle: 'This guide is no longer available on TourCoaster.',
      })
    );
  }
  return svgResponse(
    renderSvg({
      kind: 'guide',
      title: row.display_name ?? slug,
      subtitle: row.bio,
      meta: row.location || null,
    })
  );
};
ogRoute.get('/guide/:slug', guideHandler);
