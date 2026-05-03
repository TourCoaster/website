import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { AppError } from '../middleware/error';
import { getLiveInput, verifyStreamWebhookSignature } from '../stream/api';

/**
 * Cloudflare Stream webhooks. We subscribe to:
 *   - live_input.connected     — guide's encoder is publishing
 *   - live_input.disconnected  — encoder dropped
 *   - video.ready              — recording finished processing (replay URL)
 *
 * The endpoint mounts at /v1/webhooks/stream (so the path is distinct from
 * the Stripe webhook). Body is read raw for signature verification.
 */
export const streamWebhooksRoute = new Hono<AppEnv>();

streamWebhooksRoute.post('/', async (c) => {
  if (!c.env.STREAM_WEBHOOK_SECRET) {
    throw new AppError(503, 'stream_not_configured', 'Stream webhooks are not configured.');
  }
  const raw = await c.req.text();
  await verifyStreamWebhookSignature(
    raw,
    c.req.header('Webhook-Signature'),
    c.env.STREAM_WEBHOOK_SECRET
  );

  let event: { eventType?: string; type?: string; uid?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'invalid_body', 'Webhook body is not valid JSON.');
  }
  const kind = String(event.eventType ?? event.type ?? '');
  const uid = String(event.uid ?? (event.data as Record<string, unknown> | undefined)?.uid ?? '');

  if (kind === 'live_input.connected' && uid) {
    await transition(c.env, uid, 'live', { setStartedAt: true });
  } else if (kind === 'live_input.disconnected' && uid) {
    await transition(c.env, uid, 'ended', { setEndedAt: true });
  } else if (kind === 'video.ready' && uid) {
    await onRecordingReady(c.env, uid);
  }
  return c.json({ ok: true });
});

const transition = async (
  env: AppEnv['Bindings'],
  streamUid: string,
  status: 'live' | 'ended',
  flags: { setStartedAt?: boolean; setEndedAt?: boolean }
): Promise<void> => {
  const now = new Date().toISOString();
  const startedSet = flags.setStartedAt ? ', started_at = COALESCE(started_at, ?1)' : '';
  const endedSet = flags.setEndedAt ? ', ended_at = ?1' : '';
  // 'ended' is terminal: a late `live_input.connected` reordered behind a
  // disconnected event must not resurrect the stream. Constrain the UPDATE
  // so the transition only applies when the row hasn't already ended.
  await env.DB.prepare(
    `UPDATE live_streams
        SET status = ?2, last_status_at = ?1, updated_at = ?1${startedSet}${endedSet}
      WHERE stream_uid = ?3 AND status != 'ended'`
  )
    .bind(now, status, streamUid)
    .run();

  const row = await env.DB.prepare(
    `SELECT id FROM live_streams WHERE stream_uid = ?1 LIMIT 1`
  )
    .bind(streamUid)
    .first<{ id: string }>();
  if (!row) return;

  try {
    const stub = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(row.id));
    await stub.fetch('https://room/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'status', status }),
    });
  } catch { /* DO not reachable; row already updated */ }
};

const onRecordingReady = async (env: AppEnv['Bindings'], videoUid: string): Promise<void> => {
  // Stream's `video.ready` fires for a recording when the corresponding live
  // input finishes. The video has `liveInput` metadata pointing at the
  // originating live-input uid; we resolve via the Stream API to be safe.
  let liveInputUid = '';
  try {
    const v = await getLiveInput(env, videoUid).catch(() => null);
    if (v && (v as Record<string, unknown>).uid) {
      // It IS a live input — nothing to record here.
      return;
    }
  } catch { /* fall through */ }
  // Fetch the video's metadata to find the parent live input.
  try {
    const account = env.CF_ACCOUNT_ID;
    const token = env.STREAM_API_TOKEN;
    if (!account || !token) return;
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/stream/${encodeURIComponent(videoUid)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return;
    const json = (await res.json()) as { result?: { liveInput?: string } };
    liveInputUid = json.result?.liveInput ?? '';
  } catch {
    return;
  }
  if (!liveInputUid) return;

  // We deliberately store the *unsigned* manifest URL as a presence marker
  // only — recordings are created with requireSignedURLs:true so this URL
  // is not directly playable. Consumers must hit GET /v1/streams/:id/replay
  // to obtain a freshly-signed URL.
  const customer = env.STREAM_CUSTOMER_CODE || 'customer-unknown';
  const replayMarker = `https://${customer}.cloudflarestream.com/${videoUid}/manifest/video.m3u8`;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE live_streams SET recording_uid = ?1, updated_at = ?2 WHERE stream_uid = ?3`
  )
    .bind(videoUid, now, liveInputUid)
    .run();

  await env.DB.prepare(
    `UPDATE tours SET replay_hls_url = ?1, updated_at = ?2
       WHERE id = (SELECT tour_id FROM live_streams WHERE stream_uid = ?3 LIMIT 1)`
  )
    .bind(replayMarker, now, liveInputUid)
    .run();
};
