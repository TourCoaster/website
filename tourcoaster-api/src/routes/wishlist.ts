import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { AppError } from '../middleware/error';
import { requireAccessAuth } from '../auth/middleware';

export const wishlistRoute = new Hono<AppEnv>();
wishlistRoute.use('*', requireAccessAuth());

type WishRow = {
  tour_id: string;
  created_at: string;
  slug: string;
  title: string;
  location: string | null;
  price_cents: number;
  currency: string;
  cover_key: string | null;
};

wishlistRoute.get('/', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT w.tour_id, w.created_at, t.slug, t.title, t.location,
            t.price_cents, t.currency,
            (SELECT r2_key FROM tour_media
              WHERE tour_id = t.id AND kind = 'image'
              ORDER BY position LIMIT 1) AS cover_key
       FROM wishlist w
       JOIN tours t ON t.id = w.tour_id
      WHERE w.user_id = ?1 AND t.status = 'published'
      ORDER BY w.created_at DESC`
  )
    .bind(user.id)
    .all<WishRow>();
  return c.json({ items: rows.results ?? [] });
});

wishlistRoute.post('/:tour_id', async (c) => {
  const user = c.get('user');
  const tourId = c.req.param('tour_id');
  const tour = await c.env.DB.prepare(
    `SELECT id FROM tours WHERE id = ?1 AND status = 'published'`
  )
    .bind(tourId)
    .first<{ id: string }>();
  if (!tour) throw new AppError(404, 'tour_not_found', 'Tour not found.');
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO wishlist (user_id, tour_id) VALUES (?1, ?2)`
  )
    .bind(user.id, tourId)
    .run();
  return c.json({ tour_id: tourId, saved: true });
});

wishlistRoute.delete('/:tour_id', async (c) => {
  const user = c.get('user');
  await c.env.DB.prepare(
    `DELETE FROM wishlist WHERE user_id = ?1 AND tour_id = ?2`
  )
    .bind(user.id, c.req.param('tour_id'))
    .run();
  return c.json({ tour_id: c.req.param('tour_id'), saved: false });
});
