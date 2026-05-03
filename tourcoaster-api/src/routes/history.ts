import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAccessAuth } from '../auth/middleware';

export const historyRoute = new Hono<AppEnv>();
historyRoute.use('*', requireAccessAuth());

type HistoryRow = {
  tour_id: string;
  slug: string;
  title: string;
  location: string | null;
  last_seen_at: string;
  source: string;
  has_replay: number;
};

// tour_id is included in the SELECT (s.tour_id, grouped) so the dashboard can
// link to /watch/:tour_id and POST /v1/wishlist/:tour_id without a round-trip.

// Past tours the traveler watched/attended. A vr_session row means the user
// either completed a booking or had a subscription that granted them access;
// we surface a replay link when the tour has any ended stream with a recording
// (or a permanent replay_hls_url on the tour itself).
historyRoute.get('/me', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT s.tour_id,
            t.slug, t.title, t.location,
            MAX(s.created_at) AS last_seen_at,
            MAX(s.source)     AS source,
            CASE
              WHEN t.replay_hls_url IS NOT NULL THEN 1
              WHEN EXISTS (
                SELECT 1 FROM live_streams ls
                 WHERE ls.tour_id = t.id
                   AND ls.recording_uid IS NOT NULL
              ) THEN 1
              ELSE 0
            END AS has_replay
       FROM vr_sessions s
       JOIN tours t ON t.id = s.tour_id
      WHERE s.user_id = ?1
      GROUP BY s.tour_id, t.slug, t.title, t.location, t.replay_hls_url
      ORDER BY last_seen_at DESC
      LIMIT 50`
  )
    .bind(user.id)
    .all<HistoryRow>();
  return c.json({ items: rows.results ?? [] });
});
