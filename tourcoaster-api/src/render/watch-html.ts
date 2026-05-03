/**
 * Server-rendered VR/2D player shell for /watch/:tour_id.
 * The page itself is mostly progressive — A-Frame + hls.js are loaded from
 * the CDN and the heavy lifting lives in /assets/js/watch.js. We bake the
 * tour metadata + stream id + initial state into a JSON island so the
 * client never has to expose a signed URL until it has explicitly hit
 * /v1/streams/:id/playback.
 */
import { escapeHtml } from './escape';

const SITE_ORIGIN = 'https://tourcoaster.com';

export type WatchState =
  | { kind: 'live'; streamId: string }
  | { kind: 'replay'; streamId: string }
  | { kind: 'idle' }
  | { kind: 'ended'; streamId?: string; hasReplay?: boolean };

export type WatchTour = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  vr_enabled: boolean;
  replay_hls_url: string | null;
};

export type WatchData = {
  tour: WatchTour;
  state: WatchState;
  apiBase: string;
};

const renderShell = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<style>
  html,body { margin:0; padding:0; height:100%; background:#000; color:#fff; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .watch-screen { position:fixed; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; text-align:center; }
  .watch-screen h1 { font-size:1.5rem; margin:0 0 12px; }
  .watch-screen p  { max-width:520px; opacity:.85; }
  .watch-screen a.btn { display:inline-block; margin-top:18px; padding:10px 22px; background:#ff4f7b; color:#fff; border-radius:999px; text-decoration:none; font-weight:600; }
  .watch-screen a.btn.secondary { background:transparent; border:1px solid rgba(255,255,255,.4); margin-left:8px; }
</style>
</head><body>${body}</body></html>`;

export const renderPaymentRequired = (tourSlug: string, tourTitle: string): string =>
  renderShell(
    `${tourTitle} — Subscribe to watch`,
    `<div class="watch-screen">
       <h1>Subscribe to watch ${escapeHtml(tourTitle)}</h1>
       <p>Live VR tours are part of the Explorer and Wanderer plans. You can also book this tour in person to get companion VR access.</p>
       <p>
         <a class="btn" href="/pricing/">See plans</a>
         <a class="btn secondary" href="/tours/${encodeURIComponent(tourSlug)}">Tour details</a>
       </p>
     </div>`
  );

export const renderNotFound = (): string =>
  renderShell(
    'Tour not found — TourCoaster',
    `<div class="watch-screen">
       <h1>Tour not found</h1>
       <p>This tour does not exist or is no longer available.</p>
       <p><a class="btn" href="/">Back home</a></p>
     </div>`
  );

const stateLabel = (state: WatchState): string => {
  if (state.kind === 'live') return 'Live now';
  if (state.kind === 'replay') return 'Replay available';
  if (state.kind === 'ended') return 'This tour has ended';
  return 'Waiting for the guide to go live…';
};

export const renderWatchPage = (data: WatchData): string => {
  const { tour, state } = data;
  const titleText = `${tour.title} — Watch on TourCoaster`;
  // Server-rendered chrome: the headline and "fallback" message are visible
  // even before A-Frame + hls.js initialize so the page degrades gracefully.
  const description = tour.description
    ? escapeHtml(tour.description.slice(0, 240))
    : 'A 360° live tour on TourCoaster.';

  const dataIsland = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escapeHtml(titleText)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<meta name="description" content="${description}" />
<link rel="canonical" href="${SITE_ORIGIN}/tours/${encodeURIComponent(tour.slug)}" />
<script src="https://aframe.io/releases/1.5.0/aframe.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<style>
  html,body { margin:0; padding:0; height:100%; background:#000; color:#fff; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  #watch-scene, #watch-fallback { position:fixed; inset:0; }
  #watch-fallback { display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; background:#0b0b0b; }
  #watch-fallback .panel { max-width:520px; }
  #watch-fallback h1 { margin:0 0 8px; font-size:1.25rem; }
  #watch-fallback p { margin:0 0 12px; opacity:.85; }
  #watch-fallback a.btn { display:inline-block; padding:8px 18px; background:#ff4f7b; color:#fff; border-radius:999px; text-decoration:none; font-weight:600; }
  /* 2D HUD overlay (hidden once we're in VR). */
  #watch-hud { position:fixed; left:0; right:0; bottom:0; padding:14px 18px; display:flex; gap:14px; align-items:flex-end; pointer-events:none; z-index:5; }
  #watch-hud .stack { pointer-events:auto; flex:1; max-width:320px; background:rgba(0,0,0,.55); border-radius:14px; padding:10px 12px; backdrop-filter:blur(8px); }
  #watch-hud h2 { font-size:.85rem; margin:0 0 6px; opacity:.8; text-transform:uppercase; letter-spacing:.06em; }
  #watch-status { display:flex; align-items:center; gap:8px; font-weight:600; }
  #watch-status .dot { width:10px; height:10px; border-radius:50%; background:#888; box-shadow:0 0 6px rgba(255,255,255,.4); }
  #watch-status.is-live .dot { background:#ff4f7b; animation:pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { transform:scale(1); opacity:1; } 50% { transform:scale(1.4); opacity:.6; } }
  #watch-chat-list { max-height:160px; overflow-y:auto; font-size:.8rem; line-height:1.35; }
  #watch-chat-list .row { margin-bottom:4px; }
  #watch-chat-list .from { opacity:.6; margin-right:4px; }
  #watch-chat-form { display:flex; gap:6px; margin-top:6px; }
  #watch-chat-form input { flex:1; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.15); color:#fff; border-radius:999px; padding:6px 12px; font-size:.85rem; outline:none; }
  #watch-chat-form button { background:#ff4f7b; border:none; color:#fff; border-radius:999px; padding:6px 14px; font-weight:600; cursor:pointer; }
  #watch-toast { position:fixed; top:18px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,.7); padding:8px 14px; border-radius:999px; font-size:.85rem; opacity:0; pointer-events:none; transition:opacity .25s; z-index:6; }
  #watch-toast.show { opacity:1; }
  #watch-back { position:fixed; top:14px; left:14px; color:#fff; background:rgba(0,0,0,.5); padding:6px 12px; border-radius:999px; text-decoration:none; font-size:.8rem; z-index:6; }
</style>
</head><body data-auth-page="watch">
  <a id="watch-back" href="/tours/${encodeURIComponent(tour.slug)}">&larr; Tour</a>

  <a-scene id="watch-scene" embedded vr-mode-ui="enabled: true" loading-screen="dotsColor: #ff4f7b; backgroundColor: #000" device-orientation-permission-ui="enabled: true">
    <a-assets timeout="30000">
      <video id="watch-video" crossorigin="anonymous" playsinline webkit-playsinline autoplay muted></video>
    </a-assets>
    <a-videosphere id="watch-sphere" src="#watch-video" rotation="0 -90 0"></a-videosphere>
    <a-camera position="0 0 0" wasd-controls-enabled="false">
      <a-cursor color="#ffffff" opacity="0.4"></a-cursor>
    </a-camera>
    <!-- Floating in-world HUD; positioned slightly below eye line. -->
    <a-entity id="watch-vr-hud" position="0 -0.6 -1.4">
      <a-text id="watch-vr-status" value="${stateLabel(state)}" align="center" color="#ffffff" width="2.4"></a-text>
      <a-text id="watch-vr-viewers" value="0 watching" align="center" color="#ff4f7b" width="2" position="0 -0.18 0"></a-text>
    </a-entity>
    <!-- In-world chat panel anchored to the left of the viewer so chat is
         legible inside WebXR (the 2D DOM HUD isn't visible in VR). The
         panel renders the most recent six lines from /v1/streams/:id/socket.
    -->
    <a-entity id="watch-vr-chat" position="-1.6 0 -1.4" rotation="0 30 0">
      <a-plane width="1.4" height="1.0" color="#000000" opacity="0.45"></a-plane>
      <a-text value="Chat" color="#ff4f7b" width="1.2" position="-0.6 0.42 0.01"></a-text>
      <a-text id="watch-vr-chat-text" value="" color="#ffffff" width="1.3" baseline="top" anchor="left" position="-0.65 0.32 0.01" wrap-count="32"></a-text>
    </a-entity>
  </a-scene>

  <!-- 2D fallback / pre-init UI. Hidden once the player attaches. -->
  <section id="watch-fallback" role="status">
    <div class="panel">
      <h1>${escapeHtml(tour.title)}</h1>
      <p id="watch-fallback-msg">Loading the tour…</p>
      <p id="watch-fallback-cta" style="display:none;"></p>
    </div>
  </section>

  <!-- 2D HUD shown alongside the videosphere when not in VR. -->
  <div id="watch-hud" hidden>
    <div class="stack" id="watch-status-card">
      <h2>Status</h2>
      <div id="watch-status"><span class="dot"></span><span id="watch-status-label">${escapeHtml(stateLabel(state))}</span></div>
      <div style="margin-top:6px; opacity:.7; font-size:.8rem;"><span id="watch-viewer-count">0</span> watching</div>
    </div>
    <div class="stack">
      <h2>Chat</h2>
      <div id="watch-chat-list" aria-live="polite"></div>
      <form id="watch-chat-form" autocomplete="off">
        <input id="watch-chat-input" maxlength="400" placeholder="Say hi to the guide…" />
        <button type="submit">Send</button>
      </form>
    </div>
  </div>

  <div id="watch-toast" role="status"></div>

  <script id="watch-data" type="application/json">${dataIsland}</script>
  <script src="/assets/js/watch.js" defer></script>
</body></html>`;
};
