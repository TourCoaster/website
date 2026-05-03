import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAccessAuth } from '../auth/middleware';

export const bookingsRoute = new Hono<AppEnv>();
bookingsRoute.use('*', requireAccessAuth());

type BookingRow = {
  id: string;
  tour_id: string;
  scheduled_at: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  created_at: string;
  tour_slug: string;
  tour_title: string;
  tour_location: string | null;
  guide_display_name: string | null;
  guide_slug: string | null;
};

bookingsRoute.get('/me', async (c) => {
  const user = c.get('user');
  const nowIso = new Date().toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.tour_id, b.scheduled_at, b.status, b.amount_cents, b.currency,
            b.created_at,
            t.slug AS tour_slug, t.title AS tour_title, t.location AS tour_location,
            gp.display_name AS guide_display_name, gp.slug AS guide_slug
       FROM bookings b
       JOIN tours t ON t.id = b.tour_id
       LEFT JOIN guide_profiles gp ON gp.user_id = t.owner_id
      WHERE b.traveler_id = ?1
        AND b.status = 'paid'
      ORDER BY COALESCE(b.scheduled_at, b.created_at) DESC`
  )
    .bind(user.id)
    .all<BookingRow>();

  const list = rows.results ?? [];
  const upcoming: BookingRow[] = [];
  const past: BookingRow[] = [];
  for (const row of list) {
    if (row.scheduled_at && row.scheduled_at >= nowIso) upcoming.push(row);
    else past.push(row);
  }
  return c.json({ upcoming, past });
});
