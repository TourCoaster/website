import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { verifyAccessJwt } from '../auth/jwks';
import { upsertUserFromAccess } from '../auth/provision';
import { AppError } from '../middleware/error';
import {
  renderNotFound,
  renderPaymentRequired,
  renderWatchPage,
  type WatchState,
  type WatchTour,
} from '../render/watch-html';

export const watchRoute = new Hono<AppEnv>();

const cookieToken = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === 'CF_Authorization') {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return undefined;
};

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

watchRoute.get('/:tourId', async (c) => {
  const tourIdOrSlug = c.req.param('tourId');
  const path = `/watch/${encodeURIComponent(tourIdOrSlug)}` +
    (c.req.query('replay') === '1' ? '?replay=1' : '');
  const loginRedirect = (): Response =>
    c.redirect(`/login?return_to=${encodeURIComponent(path)}`, 302);

  const token =
    c.req.header('Cf-Access-Jwt-Assertion') ?? cookieToken(c.req.header('cookie'));
  if (!token) return loginRedirect();
  let claims;
  try {
    claims = await verifyAccessJwt(token, c.env);
  } catch {
    return loginRedirect();
  }
  let user;
  try {
    user = await upsertUserFromAccess(c.env, claims);
  } catch (err) {
    if (err instanceof AppError && err.status === 409) return loginRedirect();
    throw err;
  }
  if (user.status === 'suspended') {
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Account suspended</title>` +
        `<body style="font-family:system-ui;padding:32px;background:#000;color:#fff;text-align:center">` +
        `<h1>Account suspended</h1><p>Please contact support.</p></body>`,
      403,
      HTML
    );
  }

  const tour = await c.env.DB.prepare(
    `SELECT id, slug, title, description, vr_enabled, replay_hls_url, owner_id
       FROM tours
       WHERE (id = ?1 OR slug = ?1) AND status = 'published'
       LIMIT 1`
  )
    .bind(tourIdOrSlug)
    .first<{
      id: string;
      slug: string;
      title: string;
      description: string | null;
      vr_enabled: number;
      replay_hls_url: string | null;
      owner_id: string;
    }>();
  if (!tour || tour.vr_enabled !== 1) {
    return c.html(renderNotFound(), 404, HTML);
  }

  const isOwner = tour.owner_id === user.id;
  const isAdmin = user.role === 'admin';
  let allowed = isOwner || isAdmin;
  if (!allowed) {
    const sub = await c.env.DB.prepare(
      `SELECT 1 AS x FROM subscriptions
         WHERE user_id = ?1 AND status IN ('active','trialing','past_due') LIMIT 1`
    )
      .bind(user.id)
      .first<{ x: number }>();
    if (sub) allowed = true;
  }
  if (!allowed) {
    const vr = await c.env.DB.prepare(
      `SELECT 1 AS x FROM vr_sessions
         WHERE user_id = ?1 AND tour_id = ?2
           AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         LIMIT 1`
    )
      .bind(user.id, tour.id)
      .first<{ x: number }>();
    if (vr) allowed = true;
  }
  if (!allowed) {
    return c.html(renderPaymentRequired(tour.slug, tour.title), 402, HTML);
  }

  const stream = await c.env.DB.prepare(
    `SELECT id, status, recording_uid
       FROM live_streams
       WHERE tour_id = ?1
       ORDER BY created_at DESC LIMIT 1`
  )
    .bind(tour.id)
    .first<{ id: string; status: string; recording_uid: string | null }>();

  const wantsReplay = c.req.query('replay') === '1';
  let state: WatchState = { kind: 'idle' };
  if (stream) {
    if (stream.status === 'live') {
      state = { kind: 'live', streamId: stream.id };
    } else if (stream.status === 'connecting' || stream.status === 'idle') {
      state = { kind: 'idle', streamId: stream.id };
    } else if (wantsReplay && stream.recording_uid) {
      state = { kind: 'replay', streamId: stream.id };
    } else {
      state = { kind: 'ended', streamId: stream.id, hasReplay: !!stream.recording_uid };
    }
  }

  const url = new URL(c.req.url);
  const apiBase = url.host.startsWith('api.')
    ? `${url.protocol}//${url.host}`
    : 'https://api.tourcoaster.com';

  const watchTour: WatchTour = {
    id: tour.id,
    slug: tour.slug,
    title: tour.title,
    description: tour.description,
    vr_enabled: tour.vr_enabled === 1,
    hasReplay: !!stream?.recording_uid || !!tour.replay_hls_url,
  };
  return c.html(renderWatchPage({ tour: watchTour, state, apiBase }), 200, HTML);
});
