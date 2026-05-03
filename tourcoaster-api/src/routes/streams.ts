import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { AppError } from '../middleware/error';
import { requireAccessAuth, requireRole } from '../auth/middleware';
import {
  buildSignedHlsUrl,
  createLiveInput,
  decryptStreamKey,
  deleteLiveInput,
  encryptStreamKey,
  signPlaybackToken,
} from '../stream/api';

export const streamsRoute = new Hono<AppEnv>();
streamsRoute.use('*', requireAccessAuth());

type LiveStreamRow = {
  id: string;
  tour_id: string;
  owner_id: string;
  stream_uid: string;
  rtmps_url: string;
  stream_key_encrypted: string;
  hls_url: string;
  recording_uid: string | null;
  status: 'idle' | 'connecting' | 'live' | 'ended';
  started_at: string | null;
  ended_at: string | null;
  peak_viewers: number;
  last_status_at: string | null;
};

const loadStream = async (
  env: AppEnv['Bindings'],
  id: string
): Promise<LiveStreamRow | null> =>
  env.DB.prepare(
    `SELECT id, tour_id, owner_id, stream_uid, rtmps_url, stream_key_encrypted,
            hls_url, recording_uid, status, started_at, ended_at, peak_viewers,
            last_status_at
       FROM live_streams WHERE id = ?1`
  )
    .bind(id)
    .first<LiveStreamRow>();

// ---------------------------------------------------------------------------
// POST /v1/streams/start  { tour_id }
// Idempotent: if the tour already has an active row, return its credentials
// (decrypting the stored stream key on the way out).
// ---------------------------------------------------------------------------

streamsRoute.post('/start', requireRole('guide'), async (c) => {
  const user = c.get('user');
  let body: { tour_id?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }
  const tourId = typeof body.tour_id === 'string' ? body.tour_id : '';
  if (!tourId) throw new AppError(422, 'missing_tour_id', 'tour_id is required.');

  const tour = await c.env.DB.prepare(
    `SELECT id, owner_id, vr_enabled, status FROM tours WHERE id = ?1`
  )
    .bind(tourId)
    .first<{ id: string; owner_id: string; vr_enabled: number; status: string }>();
  if (!tour) throw new AppError(404, 'tour_not_found', 'Tour not found.');
  if (tour.owner_id !== user.id) throw new AppError(403, 'not_owner', 'You do not own this tour.');
  if (tour.vr_enabled !== 1) {
    throw new AppError(409, 'vr_not_enabled', 'Enable VR on this tour before going live.');
  }
  // Server-side gate so a guide can't bypass the dashboard filter and start
  // a live input on a draft / deleted tour.
  if (tour.status !== 'published') {
    throw new AppError(409, 'tour_not_published', 'Publish the tour before going live.');
  }

  // Reuse an existing active row instead of leaking live inputs.
  const existing = await c.env.DB.prepare(
    `SELECT id, tour_id, owner_id, stream_uid, rtmps_url, stream_key_encrypted, hls_url,
            recording_uid, status, started_at, ended_at, peak_viewers, last_status_at
       FROM live_streams
       WHERE tour_id = ?1 AND status IN ('idle','connecting','live')
       ORDER BY created_at DESC LIMIT 1`
  )
    .bind(tourId)
    .first<LiveStreamRow>();

  if (existing) {
    const streamKey = await decryptStreamKey(c.env, existing.stream_key_encrypted);
    return c.json({
      id: existing.id,
      tour_id: existing.tour_id,
      stream_uid: existing.stream_uid,
      rtmps_url: existing.rtmps_url,
      stream_key: streamKey,
      hls_url: existing.hls_url,
      status: existing.status,
      reused: true,
    });
  }

  const live = await createLiveInput(c.env, {
    tourcoaster_tour_id: tour.id,
    tourcoaster_owner_id: user.id,
  });

  const id = crypto.randomUUID();
  const encrypted = await encryptStreamKey(c.env, live.rtmps.streamKey);
  const customer = c.env.STREAM_CUSTOMER_CODE || 'customer-unknown';
  const hlsUrl = `https://${customer}.cloudflarestream.com/${live.uid}/manifest/video.m3u8`;

  try {
    await c.env.DB.prepare(
      `INSERT INTO live_streams
         (id, tour_id, owner_id, stream_uid, rtmps_url, stream_key_encrypted,
          hls_url, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'idle')`
    )
      .bind(id, tour.id, user.id, live.uid, live.rtmps.url, encrypted, hlsUrl)
      .run();
  } catch (err) {
    // Always delete the orphaned live input on DB failure. Two cases here:
    //   1. Generic DB error — straightforward leak prevention.
    //   2. UNIQUE-index violation from `idx_live_streams_active_per_tour` —
    //      another concurrent request beat us to it, so we throw away our
    //      duplicate input and re-read the row that won.
    try { await deleteLiveInput(c.env, live.uid); } catch { /* swallow */ }
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      const winner = await c.env.DB.prepare(
        `SELECT id, tour_id, owner_id, stream_uid, rtmps_url, stream_key_encrypted, hls_url,
                recording_uid, status, started_at, ended_at, peak_viewers, last_status_at
           FROM live_streams
           WHERE tour_id = ?1 AND status IN ('idle','connecting','live')
           ORDER BY created_at DESC LIMIT 1`
      )
        .bind(tour.id)
        .first<LiveStreamRow>();
      if (winner) {
        const streamKey = await decryptStreamKey(c.env, winner.stream_key_encrypted);
        return c.json({
          id: winner.id,
          tour_id: winner.tour_id,
          stream_uid: winner.stream_uid,
          rtmps_url: winner.rtmps_url,
          stream_key: streamKey,
          hls_url: winner.hls_url,
          status: winner.status,
          reused: true,
        });
      }
    }
    throw err;
  }

  return c.json({
    id,
    tour_id: tour.id,
    stream_uid: live.uid,
    rtmps_url: live.rtmps.url,
    stream_key: live.rtmps.streamKey,
    hls_url: hlsUrl,
    status: 'idle',
  });
});

// ---------------------------------------------------------------------------
// POST /v1/streams/:id/stop
// Marks the row 'ended' and deletes the upstream live input. Idempotent.
// ---------------------------------------------------------------------------

streamsRoute.post('/:id/stop', requireRole('guide'), async (c) => {
  const user = c.get('user');
  const row = await loadStream(c.env, c.req.param('id'));
  if (!row) throw new AppError(404, 'stream_not_found', 'Stream not found.');
  if (row.owner_id !== user.id) throw new AppError(403, 'not_owner', 'You do not own this stream.');

  if (row.status !== 'ended') {
    await c.env.DB.prepare(
      `UPDATE live_streams SET status = 'ended', ended_at = ?1, last_status_at = ?1,
              updated_at = ?1
         WHERE id = ?2`
    )
      .bind(new Date().toISOString(), row.id)
      .run();
    try { await deleteLiveInput(c.env, row.stream_uid); } catch { /* tolerated */ }
    // Push status to any open WebSockets.
    try {
      const stub = c.env.LIVE_ROOMS.get(c.env.LIVE_ROOMS.idFromName(row.id));
      await stub.fetch('https://room/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'status', status: 'ended' }),
      });
    } catch { /* DO unavailable; status still persisted */ }
  }

  return c.json({ id: row.id, status: 'ended' });
});

// ---------------------------------------------------------------------------
// GET /v1/streams/:id/playback
// Gating: stream owner OR active subscription (any plan) OR a vr_session for
// the tour. Returns a 2-hour signed HLS URL.
// ---------------------------------------------------------------------------

const userHasActiveSubscription = async (
  env: AppEnv['Bindings'],
  userId: string
): Promise<boolean> => {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM subscriptions
       WHERE user_id = ?1 AND status IN ('active','trialing','past_due') LIMIT 1`
  )
    .bind(userId)
    .first<{ x: number }>();
  return !!row;
};

const userHasVrSession = async (
  env: AppEnv['Bindings'],
  userId: string,
  tourId: string
): Promise<boolean> => {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM vr_sessions
       WHERE user_id = ?1 AND tour_id = ?2
         AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       LIMIT 1`
  )
    .bind(userId, tourId)
    .first<{ x: number }>();
  return !!row;
};

streamsRoute.get('/:id/playback', async (c) => {
  const user = c.get('user');
  const row = await loadStream(c.env, c.req.param('id'));
  if (!row) throw new AppError(404, 'stream_not_found', 'Stream not found.');

  const allowed =
    row.owner_id === user.id ||
    user.role === 'admin' ||
    (await userHasActiveSubscription(c.env, user.id)) ||
    (await userHasVrSession(c.env, user.id, row.tour_id));
  if (!allowed) {
    throw new AppError(402, 'payment_required', 'A subscription or booking is required to watch this tour.');
  }

  const { token, expiresAt } = await signPlaybackToken(c.env, { uid: row.stream_uid });
  return c.json({
    hls_url: buildSignedHlsUrl(c.env, token),
    expires_at: new Date(expiresAt * 1000).toISOString(),
    status: row.status,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/streams/:id/replay
// Recordings are created with `recording.requireSignedURLs: true`, so the
// `tours.replay_hls_url` value is just a marker — actual playback needs a
// fresh signed JWT. Same ACL as live playback. 404 if the recording hasn't
// landed yet.
// ---------------------------------------------------------------------------

streamsRoute.get('/:id/replay', async (c) => {
  const user = c.get('user');
  const row = await loadStream(c.env, c.req.param('id'));
  if (!row) throw new AppError(404, 'stream_not_found', 'Stream not found.');
  if (!row.recording_uid) {
    throw new AppError(404, 'recording_not_ready', 'No recording is available for this stream yet.');
  }

  const allowed =
    row.owner_id === user.id ||
    user.role === 'admin' ||
    (await userHasActiveSubscription(c.env, user.id)) ||
    (await userHasVrSession(c.env, user.id, row.tour_id));
  if (!allowed) {
    throw new AppError(402, 'payment_required', 'A subscription or booking is required to watch this replay.');
  }

  const { token, expiresAt } = await signPlaybackToken(c.env, { uid: row.recording_uid });
  return c.json({
    hls_url: buildSignedHlsUrl(c.env, token),
    expires_at: new Date(expiresAt * 1000).toISOString(),
    recording_uid: row.recording_uid,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/streams/:id/status — polling fallback for non-WebSocket clients.
// ---------------------------------------------------------------------------

streamsRoute.get('/:id/status', async (c) => {
  const user = c.get('user');
  const row = await loadStream(c.env, c.req.param('id'));
  if (!row) throw new AppError(404, 'stream_not_found', 'Stream not found.');

  // Same gating as /playback and /socket so an authenticated stranger
  // can't enumerate viewer counts / status by guessing stream ids.
  const allowed =
    row.owner_id === user.id ||
    user.role === 'admin' ||
    (await userHasActiveSubscription(c.env, user.id)) ||
    (await userHasVrSession(c.env, user.id, row.tour_id));
  if (!allowed) {
    throw new AppError(402, 'payment_required', 'A subscription or booking is required to view this stream.');
  }

  let viewerCount = 0;
  try {
    const stub = c.env.LIVE_ROOMS.get(c.env.LIVE_ROOMS.idFromName(row.id));
    const res = await stub.fetch('https://room/state');
    if (res.ok) {
      const data = (await res.json()) as { viewer_count?: number };
      viewerCount = Number(data.viewer_count ?? 0);
    }
  } catch { /* DO not addressable; report 0 */ }

  return c.json({
    id: row.id,
    tour_id: row.tour_id,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    viewer_count: viewerCount,
    last_status_at: row.last_status_at,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/streams/:id/socket — WebSocket upgrade, gated by playback ACL.
// Forwards to LiveTourRoom DO with the user id stamped on the connection.
// ---------------------------------------------------------------------------

streamsRoute.get('/:id/socket', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    throw new AppError(400, 'expected_websocket', 'WebSocket upgrade required.');
  }
  const user = c.get('user');
  const row = await loadStream(c.env, c.req.param('id'));
  if (!row) throw new AppError(404, 'stream_not_found', 'Stream not found.');

  const allowed =
    row.owner_id === user.id ||
    user.role === 'admin' ||
    (await userHasActiveSubscription(c.env, user.id)) ||
    (await userHasVrSession(c.env, user.id, row.tour_id));
  if (!allowed) {
    throw new AppError(402, 'payment_required', 'A subscription or booking is required to join.');
  }

  const stub = c.env.LIVE_ROOMS.get(c.env.LIVE_ROOMS.idFromName(row.id));
  const target = new URL('https://room/ws');
  target.searchParams.set('userId', user.id);
  target.searchParams.set('role', user.role ?? 'traveler');
  return stub.fetch(target.toString(), {
    headers: { Upgrade: 'websocket' },
  });
});
