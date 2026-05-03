/* eslint-disable */
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

  function fmtDuration(ms) {
    if (!ms || ms < 0) return '00:00';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(ss);
  }

  // -------------------- Pre-flight checklist --------------------

  var checks = { camera: false, speed: false, tour: false };

  function setCheck(name, ok, opts) {
    checks[name] = !!ok;
    var li = document.querySelector('[data-check="' + name + '"]');
    if (li) {
      var icon = li.querySelector('.preflight-icon');
      if (icon) icon.textContent = ok ? '✅' : (opts && opts.failed ? '⚠️' : '⏳');
    }
    refreshStartButton();
  }

  function refreshStartButton() {
    var btn = document.getElementById('live-start-btn');
    if (!btn) return;
    btn.disabled = !(checks.camera && checks.speed && checks.tour) || !!currentStreamId;
  }

  async function testCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      setCheck('camera', false, { failed: true });
      return;
    }
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      var hasCam = devices.some(function (d) { return d.kind === 'videoinput'; });
      setCheck('camera', hasCam, { failed: !hasCam });
    } catch (_) {
      setCheck('camera', false, { failed: true });
    }
  }

  async function testSpeed() {
    var detail = document.getElementById('preflight-speed-detail');
    var btn = document.getElementById('preflight-speed-btn');
    if (btn) btn.disabled = true;
    if (detail) detail.textContent = '(testing…)';
    var sizeMb = 4;
    var bytes = sizeMb * 1024 * 1024;
    var blob = new Uint8Array(bytes);
    var t0 = performance.now();
    try {
      var res = await api('/v1/speedtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      if (!res.ok) throw new Error('speedtest http ' + res.status);
      var t1 = performance.now();
      var seconds = (t1 - t0) / 1000;
      var mbps = (bytes * 8) / seconds / 1e6;
      var pass = mbps >= 10;
      if (detail) detail.textContent = '(' + mbps.toFixed(1) + ' Mbps' + (pass ? ')' : ' — needs ≥ 10)');
      setCheck('speed', pass, { failed: !pass });
    } catch (_) {
      if (detail) detail.textContent = '(test failed)';
      setCheck('speed', false, { failed: true });
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // -------------------- Stream lifecycle --------------------

  var ws = null;
  var currentStreamId = null;
  var currentTour = null;
  var startedAt = null;
  var peakViewers = 0;
  var pollTimer = null;
  var durationTimer = null;

  function openSocket(streamId) {
    if (ws) try { ws.close(); } catch (_) {}
    var proto = API_BASE.indexOf('https') === 0 ? 'wss://' : 'ws://';
    var host = API_BASE.replace(/^https?:\/\//, '');
    try { ws = new WebSocket(proto + host + '/v1/streams/' + streamId + '/socket'); } catch (_) { return; }
    ws.addEventListener('message', function (ev) {
      var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (data.type === 'hello' || data.type === 'status') {
        if (data.status) setBadge(data.status);
        if (data.status === 'live' && !startedAt) startedAt = Date.now();
        if (data.status === 'ended') onStreamEnded();
      }
      if (typeof data.viewer_count === 'number') updateViewers(data.viewer_count);
    });
  }

  function updateViewers(n) {
    var v = Math.max(0, n | 0);
    if (v > peakViewers) peakViewers = v;
    var el = document.getElementById('live-viewer-count');
    if (el) el.textContent = String(v);
  }

  async function pollStatus() {
    if (!currentStreamId) return;
    try {
      var res = await api('/v1/streams/' + currentStreamId + '/status');
      if (!res.ok) return;
      var json = await res.json();
      setBadge(json.status);
      if (typeof json.viewer_count === 'number') updateViewers(json.viewer_count);
      if (json.started_at && !startedAt) startedAt = new Date(json.started_at).getTime();
      if (json.status === 'ended') onStreamEnded(json);
    } catch (_) { /* tolerate transient errors */ }
  }

  function tickDuration() {
    var el = document.getElementById('live-duration');
    if (!el) return;
    el.textContent = startedAt ? fmtDuration(Date.now() - startedAt) : '00:00';
  }

  async function loadTours() {
    var statusEl = document.getElementById('live-status');
    var meRes = await api('/v1/me');
    if (meRes.status === 401) {
      location.href = '/login?return_to=' + encodeURIComponent(location.pathname);
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
    document.getElementById('preflight-card').style.display = '';
    document.getElementById('live-card').style.display = '';

    var sel = document.getElementById('live-tour');
    if (eligible.length === 0) {
      sel.innerHTML = '<option value="">— no eligible tours —</option>';
      setBanner('Publish a VR-enabled tour first to go live.', 'info');
      return;
    }
    sel.innerHTML = '<option value="">— choose a tour —</option>' + eligible
      .map(function (t) { return '<option value="' + t.id + '" data-slug="' + t.slug + '">' + t.title + '</option>'; })
      .join('');
    sel.addEventListener('change', function () {
      var opt = sel.options[sel.selectedIndex];
      currentTour = opt && opt.value ? { id: opt.value, slug: opt.getAttribute('data-slug') } : null;
      setCheck('tour', !!currentTour);
      var link = document.getElementById('live-test-link');
      if (link) {
        if (currentTour) { link.href = '/watch/' + currentTour.slug; link.style.display = ''; }
        else { link.style.display = 'none'; }
      }
    });
  }

  async function startStream() {
    if (!currentTour) return;
    var btn = document.getElementById('live-start-btn');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      var res = await api('/v1/streams/start', { method: 'POST', body: JSON.stringify({ tour_id: currentTour.id }) });
      var json = await res.json();
      if (!res.ok) throw new Error((json && json.error && json.error.message) || 'Failed to start stream.');
      currentStreamId = json.id;
      document.getElementById('live-rtmps').textContent = json.rtmps_url;
      var keyEl = document.getElementById('live-key');
      keyEl.textContent = '••••••••••••';
      keyEl.dataset.key = json.stream_key;
      document.getElementById('live-creds').style.display = '';
      document.getElementById('live-status-panel').style.display = '';
      document.getElementById('live-stop-btn').style.display = '';
      setBadge(json.status || 'idle');
      openSocket(json.id);
      pollTimer = setInterval(pollStatus, 3000);
      durationTimer = setInterval(tickDuration, 1000);
      btn.textContent = 'Credentials generated';
    } catch (e) {
      setBanner(e.message, 'danger');
      btn.disabled = false;
      btn.textContent = 'Generate stream credentials';
    }
  }

  function onStreamEnded(statusJson) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    setBadge('ended');
    if (ws) try { ws.close(); } catch (_) {}

    var endedAt = (statusJson && statusJson.ended_at) ? new Date(statusJson.ended_at).getTime() : Date.now();
    document.getElementById('postlive-duration').textContent = startedAt ? fmtDuration(endedAt - startedAt) : '—';
    document.getElementById('postlive-peak').textContent = String(peakViewers);
    if (currentTour) {
      var rec = document.getElementById('postlive-recording');
      rec.innerHTML = 'Available on the <a href="/tours/' + currentTour.slug + '">tour page</a> once Cloudflare finishes processing.';
      var share = document.getElementById('postlive-share-link');
      share.href = location.origin + '/tours/' + currentTour.slug;
      share.style.display = '';
      var copyBtn = document.getElementById('postlive-copy-share');
      copyBtn.style.display = '';
      copyBtn.onclick = function () {
        if (navigator.clipboard) navigator.clipboard.writeText(share.href).then(function () { setBanner('Share link copied.', 'info'); });
      };
    }
    document.getElementById('postlive-card').style.display = '';
  }

  async function stopStream() {
    if (!currentStreamId) return;
    var btn = document.getElementById('live-stop-btn');
    if (!confirm('End the live stream now?')) return;
    btn.disabled = true;
    try {
      var res = await api('/v1/streams/' + currentStreamId + '/stop', { method: 'POST' });
      if (!res.ok) {
        var j = await res.json().catch(function () { return null; });
        throw new Error((j && j.error && j.error.message) || 'Failed to stop stream.');
      }
      onStreamEnded();
      setBanner('Stream ended.', 'success');
    } catch (e) {
      setBanner(e.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  function copy(text, msg) {
    if (!text) return;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { setBanner(msg, 'info'); });
  }

  function toggleKey() {
    var keyEl = document.getElementById('live-key');
    var btn = document.getElementById('live-key-toggle');
    var key = keyEl.dataset.key || '';
    if (!key) return;
    if (keyEl.textContent.indexOf('•') !== -1) {
      keyEl.textContent = key; btn.textContent = 'hide';
    } else {
      keyEl.textContent = '••••••••••••'; btn.textContent = 'show';
    }
  }

  function streamAgain() {
    document.getElementById('postlive-card').style.display = 'none';
    document.getElementById('live-creds').style.display = 'none';
    document.getElementById('live-status-panel').style.display = 'none';
    document.getElementById('live-stop-btn').style.display = 'none';
    var btn = document.getElementById('live-start-btn');
    btn.textContent = 'Generate stream credentials';
    currentStreamId = null; startedAt = null; peakViewers = 0;
    refreshStartButton();
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (document.body.getAttribute('data-auth-page') !== 'dashboard-live') return;
    loadTours().catch(function (e) { console.error(e); setBanner('Unexpected error.', 'danger'); });
    document.getElementById('live-start-btn').addEventListener('click', startStream);
    document.getElementById('live-stop-btn').addEventListener('click', stopStream);
    document.getElementById('live-copy-key').addEventListener('click', function () {
      var k = document.getElementById('live-key').dataset.key; copy(k, 'Stream key copied.');
    });
    document.getElementById('live-copy-rtmps').addEventListener('click', function () {
      copy(document.getElementById('live-rtmps').textContent, 'RTMPS URL copied.');
    });
    document.getElementById('live-key-toggle').addEventListener('click', toggleKey);
    document.getElementById('preflight-camera-btn').addEventListener('click', testCamera);
    document.getElementById('preflight-speed-btn').addEventListener('click', testSpeed);
    document.getElementById('postlive-again').addEventListener('click', streamAgain);
    testCamera();
  });
})();
