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

// Past tours the traveler watched (vr_sessions) OR attended in person (paid
// bookings whose scheduled_at has passed). De-duplicated per tour, sorted by
// the most recent attendance/watch time.
historyRoute.get('/me', async (c) => {
  const user = c.get('user');
  const nowIso = new Date().toISOString();
  const rows = await c.env.DB.prepare(
    `WITH events AS (
       SELECT tour_id, created_at  AS seen_at, source FROM vr_sessions
        WHERE user_id = ?1
       UNION ALL
       SELECT tour_id, COALESCE(scheduled_at, created_at) AS seen_at,
              'booking' AS source
         FROM bookings
        WHERE traveler_id = ?1
          AND status = 'paid'
          AND COALESCE(scheduled_at, created_at) <= ?2
     )
     SELECT e.tour_id,
            t.slug, t.title, t.location,
            MAX(e.seen_at) AS last_seen_at,
            MAX(e.source)  AS source,
            CASE
              WHEN t.replay_hls_url IS NOT NULL THEN 1
              WHEN EXISTS (
                SELECT 1 FROM live_streams ls
                 WHERE ls.tour_id = t.id
                   AND ls.recording_uid IS NOT NULL
              ) THEN 1
              ELSE 0
            END AS has_replay
       FROM events e
       JOIN tours t ON t.id = e.tour_id
      GROUP BY e.tour_id, t.slug, t.title, t.location, t.replay_hls_url
      ORDER BY last_seen_at DESC
      LIMIT 50`
  )
    .bind(user.id, nowIso)
    .all<HistoryRow>();
  return c.json({ items: rows.results ?? [] });
});
