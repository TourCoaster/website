/* eslint-disable */
/**
 * Guide-side "Go Live" page.
 *
 * Lists the guide's published, VR-enabled tours; on Start we POST to
 * /v1/streams/start, surface the RTMPS URL + stream key once, and open a
 * WebSocket to /v1/streams/:id/socket so the status badge updates live as
 * Cloudflare Stream sees the encoder come online and go offline.
 */
(function () {
  'use strict';

  var API_BASE =
    window.TOURCOASTER_API_BASE ||
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '0.0.0.0'
      ? 'http://localhost:8787'
      : 'https://api.tourcoaster.com');

  function api(path, init) {
    if (window.TourCoasterAuth && window.TourCoasterAuth.api) {
      return window.TourCoasterAuth.api(path, init);
    }
    init = init || {};
    init.credentials = 'include';
    init.headers = Object.assign(
      { Accept: 'application/json' },
      init.body ? { 'Content-Type': 'application/json' } : {},
      init.headers || {}
    );
    return fetch(API_BASE + path, init);
  }

  function setBanner(text, kind) {
    var b = document.getElementById('live-banner');
    if (!b) return;
    b.className = 'alert alert-' + kind + ' mt-3';
    b.textContent = text;
    b.classList.remove('d-none');
  }

  function setBadge(state) {
    var b = document.getElementById('live-state-badge');
    if (!b) return;
    b.textContent = state;
    var color = state === 'live' ? 'success' : state === 'connecting' ? 'warning' : state === 'ended' ? 'dark' : 'secondary';
    b.className = 'badge bg-' + color;
  }

  var ws = null;
  var currentStreamId = null;

  function openSocket(streamId) {
    if (ws) try { ws.close(); } catch (_) {}
    currentStreamId = streamId;
    var proto = API_BASE.indexOf('https') === 0 ? 'wss://' : 'ws://';
    var host = API_BASE.replace(/^https?:\/\//, '');
    try {
      ws = new WebSocket(proto + host + '/v1/streams/' + streamId + '/socket');
    } catch (e) { return; }
    ws.addEventListener('message', function (ev) {
      var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (data.type === 'hello' && data.status) setBadge(data.status);
      if (data.type === 'status' && data.status) setBadge(data.status);
    });
  }

  async function loadTours() {
    var statusEl = document.getElementById('live-status');
    var meRes = await api('/v1/me');
    if (meRes.status === 401) {
      var ret = encodeURIComponent(location.pathname);
      location.href = '/login?return_to=' + ret;
      return;
    }
    if (!meRes.ok) { statusEl.textContent = 'Could not load your account.'; return; }
    var me = await meRes.json();
    if (me.role !== 'guide') {
      statusEl.className = 'alert alert-warning';
      statusEl.textContent = 'Only guides can go live.';
      return;
    }

    var toursRes = await api('/v1/tours/mine');
    if (!toursRes.ok) { statusEl.textContent = 'Could not load your tours.'; return; }
    var toursJson = await toursRes.json();
    var eligible = (toursJson.tours || []).filter(function (t) {
      return t.vr_enabled && t.status === 'published';
    });
    statusEl.style.display = 'none';
    document.getElementById('live-card').style.display = '';
    var sel = document.getElementById('live-tour');
    if (eligible.length === 0) {
      sel.innerHTML = '<option value="">— no eligible tours —</option>';
      document.getElementById('live-start-btn').disabled = true;
      setBanner('Publish a VR-enabled tour first to go live.', 'info');
      return;
    }
    sel.innerHTML = eligible
      .map(function (t) { return '<option value="' + t.id + '">' + t.title + '</option>'; })
      .join('');
  }

  async function startStream() {
    var btn = document.getElementById('live-start-btn');
    var tourId = document.getElementById('live-tour').value;
    if (!tourId) return;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      var res = await api('/v1/streams/start', { method: 'POST', body: JSON.stringify({ tour_id: tourId }) });
      var json = await res.json();
      if (!res.ok) throw new Error((json && json.error && json.error.message) || 'Failed to start stream.');
      document.getElementById('live-rtmps').textContent = json.rtmps_url;
      document.getElementById('live-key').textContent = json.stream_key;
      document.getElementById('live-creds').style.display = '';
      document.getElementById('live-stop-btn').style.display = '';
      setBadge(json.status || 'idle');
      openSocket(json.id);
      btn.textContent = 'Regenerate (uses existing)';
    } catch (e) {
      setBanner(e.message, 'danger');
      btn.textContent = 'Generate stream credentials';
    } finally {
      btn.disabled = false;
    }
  }

  async function stopStream() {
    if (!currentStreamId) return;
    var btn = document.getElementById('live-stop-btn');
    btn.disabled = true;
    try {
      var res = await api('/v1/streams/' + currentStreamId + '/stop', { method: 'POST' });
      if (!res.ok) {
        var j = await res.json().catch(function () { return null; });
        throw new Error((j && j.error && j.error.message) || 'Failed to stop stream.');
      }
      setBadge('ended');
      setBanner('Stream ended. Recording will appear on the tour page once Cloudflare finishes processing.', 'success');
      if (ws) try { ws.close(); } catch (_) {}
    } catch (e) {
      setBanner(e.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  function copyKey() {
    var k = document.getElementById('live-key').textContent;
    if (!k || k === '—') return;
    if (navigator.clipboard) navigator.clipboard.writeText(k).then(function () { setBanner('Stream key copied.', 'info'); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (document.body.getAttribute('data-auth-page') !== 'dashboard-live') return;
    loadTours().catch(function (e) { console.error(e); setBanner('Unexpected error.', 'danger'); });
    document.getElementById('live-start-btn').addEventListener('click', startStream);
    document.getElementById('live-stop-btn').addEventListener('click', stopStream);
    document.getElementById('live-copy-key').addEventListener('click', copyKey);
  });
})();
