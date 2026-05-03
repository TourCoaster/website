import { Hono } from 'hono';
import type { Context } from 'hono';
import { ImageResponse } from 'workers-og';
import type { AppEnv } from '../types';

export const ogRoute = new Hono<AppEnv>();

const SITE_NAME = 'TourCoaster';
const W = 1200;
const H = 630;
const ACCENT_TOUR = '#16a34a';
const ACCENT_GUIDE = '#0ea5e9';

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );

type Card = {
  kind: 'tour' | 'guide' | 'site';
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  badge?: string | null;
};

const cardHtml = (card: Card): string => {
  const accent = card.kind === 'guide' ? ACCENT_GUIDE : ACCENT_TOUR;
  const badge = card.badge ?? (card.kind === 'tour' ? 'Tour' : card.kind === 'guide' ? 'Guide' : '');
  const title = escape(card.title);
  const subtitle = card.subtitle ? escape(card.subtitle) : '';
  const meta = card.meta ? escape(card.meta) : '';
  return `<div style="display:flex;flex-direction:column;width:100%;height:100%;background:linear-gradient(135deg,#0b1220 0%,#0f2a1d 100%);color:#fff;font-family:sans-serif;padding:80px;box-sizing:border-box;border-left:14px solid ${accent};">
    <div style="display:flex;align-items:center;font-size:32px;font-weight:800;letter-spacing:1px;">
      <div style="display:flex;width:40px;height:40px;border-radius:20px;background:${accent};margin-right:20px;"></div>
      ${escape(SITE_NAME)}
    </div>
    ${
      badge
        ? `<div style="display:flex;align-self:flex-start;margin-top:40px;padding:8px 22px;border-radius:22px;background:${accent};font-size:24px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${escape(badge)}</div>`
        : ''
    }
    <div style="display:flex;font-size:76px;font-weight:800;line-height:1.1;margin-top:48px;max-width:1040px;">${title}</div>
    ${
      subtitle
        ? `<div style="display:flex;font-size:36px;font-weight:500;color:#cbd5e1;margin-top:32px;max-width:1040px;line-height:1.3;">${subtitle}</div>`
        : ''
    }
    <div style="display:flex;flex:1;"></div>
    ${
      meta
        ? `<div style="display:flex;font-size:28px;font-weight:600;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;">${meta}</div>`
        : ''
    }
  </div>`;
};

const renderResponse = async (card: Card, fmt: 'png' | 'svg'): Promise<Response> => {
  const res = new ImageResponse(cardHtml(card), { width: W, height: H, format: fmt });
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': fmt === 'png' ? 'image/png' : 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=86400',
    },
  });
};

const parseExt = (raw: string): { id: string; fmt: 'png' | 'svg' } => {
  const m = raw.match(/^(.*?)\.(png|svg)$/i);
  if (m) return { id: m[1]!, fmt: m[2]!.toLowerCase() as 'png' | 'svg' };
  return { id: raw, fmt: 'png' };
};

ogRoute.get('/', (c) =>
  c.text('TourCoaster OG image worker. Try /tour/:id.png or /guide/:slug.png.', 200)
);

const sitePromo: Card = {
  kind: 'site',
  title: 'Tours, guides, and live VR — for everyone.',
  subtitle:
    'TourCoaster connects travellers with verified local guides for in-person and immersive VR tours.',
  meta: 'tourcoaster.com',
};
ogRoute.get('/site.png', () => renderResponse(sitePromo, 'png'));
ogRoute.get('/site.svg', () => renderResponse(sitePromo, 'svg'));

const tourHandler = async (c: Context<AppEnv>) => {
  const { id, fmt } = parseExt(c.req.param('id') ?? '');
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
    .bind(id)
    .first<{
      title: string;
      location: string | null;
      category: string | null;
      vr_enabled: number;
      guide_display_name: string | null;
    }>();
  if (!row) {
    return renderResponse(
      {
        kind: 'site',
        title: 'Tour not found',
        subtitle: 'This tour is no longer available on TourCoaster.',
      },
      fmt
    );
  }
  const meta = [row.location, row.category].filter(Boolean).join(' · ');
  return renderResponse(
    {
      kind: 'tour',
      title: row.title,
      subtitle: row.guide_display_name ? `with ${row.guide_display_name}` : null,
      meta: meta || null,
      badge: row.vr_enabled === 1 ? 'VR Tour' : 'Tour',
    },
    fmt
  );
};
ogRoute.get('/tour/:id', tourHandler);

const guideHandler = async (c: Context<AppEnv>) => {
  const { id: slug, fmt } = parseExt(c.req.param('slug') ?? '');
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
    return renderResponse(
      {
        kind: 'site',
        title: 'Guide not found',
        subtitle: 'This guide is no longer available on TourCoaster.',
      },
      fmt
    );
  }
  return renderResponse(
    {
      kind: 'guide',
      title: row.display_name ?? slug,
      subtitle: row.bio,
      meta: row.location || null,
    },
    fmt
  );
};
ogRoute.get('/guide/:slug', guideHandler);
