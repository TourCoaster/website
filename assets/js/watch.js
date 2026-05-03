/* eslint-disable */
(function () {
  'use strict';

  var data;
  try {
    data = JSON.parse(document.getElementById('watch-data').textContent || '{}');
  } catch (_) { data = {}; }
  var tour = data.tour || {};
  var state = data.state || { kind: 'idle' };
  var apiBase = data.apiBase || '';

  var videoEl = document.getElementById('watch-video');
  var fallback = document.getElementById('watch-fallback');
  var fallbackMsg = document.getElementById('watch-fallback-msg');
  var fallbackCta = document.getElementById('watch-fallback-cta');
  var hud = document.getElementById('watch-hud');
  var statusEl = document.getElementById('watch-status');
  var statusLabel = document.getElementById('watch-status-label');
  var viewerEl = document.getElementById('watch-viewer-count');
  var chatList = document.getElementById('watch-chat-list');
  var chatForm = document.getElementById('watch-chat-form');
  var chatInput = document.getElementById('watch-chat-input');
  var vrViewers = document.getElementById('watch-vr-viewers');
  var vrStatus = document.getElementById('watch-vr-status');
  var vrChatText = document.getElementById('watch-vr-chat-text');
  var vrChatBuffer = [];
  var toast = document.getElementById('watch-toast');

  function api(path, init) {
    init = init || {};
    init.credentials = 'include';
    init.headers = Object.assign(
      { Accept: 'application/json' },
      init.body ? { 'Content-Type': 'application/json' } : {},
      init.headers || {}
    );
    return fetch(apiBase + path, init);
  }

  function showToast(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2500);
  }

  function setStatus(label, kind) {
    if (statusLabel) statusLabel.textContent = label;
    if (statusEl) statusEl.classList.toggle('is-live', kind === 'live');
    if (vrStatus && vrStatus.setAttribute) vrStatus.setAttribute('value', label);
  }

  function setViewerCount(n) {
    var v = String(Math.max(0, n | 0));
    if (viewerEl) viewerEl.textContent = v;
    if (vrViewers && vrViewers.setAttribute) vrViewers.setAttribute('value', v + ' watching');
  }

  function showFallback(title, ctaHtml) {
    fallback.style.display = '';
    fallbackMsg.textContent = title;
    if (ctaHtml) {
      fallbackCta.innerHTML = ctaHtml;
      fallbackCta.style.display = '';
    } else {
      fallbackCta.style.display = 'none';
    }
  }

  function hideFallback() {
    fallback.style.display = 'none';
    if (hud) hud.hidden = false;
  }

  var hls = null;
  function attachHls(url) {
    var canNative = videoEl.canPlayType('application/vnd.apple.mpegurl') !== '';
    if (canNative) {
      videoEl.src = url;
    } else if (window.Hls && window.Hls.isSupported()) {
      if (hls) try { hls.destroy(); } catch (_) {}
      hls = new window.Hls({ liveDurationInfinity: true });
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(window.Hls.Events.ERROR, function (_e, info) {
        if (info && info.fatal) {
          showToast('Playback error — retrying…');
          setTimeout(function () { startPlayback(); }, 2500);
        }
      });
    } else {
      showFallback('This browser cannot play 360° HLS streams.', '');
      return;
    }
    var play = videoEl.play();
    if (play && play.catch) {
      play.catch(function () {
        showFallback('Tap to start the tour.', '<a class="btn" href="#" id="watch-tap-start">Start</a>');
        var btn = document.getElementById('watch-tap-start');
        if (btn) btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          videoEl.play().then(hideFallback).catch(function () {});
        });
      });
    }
  }

  async function startPlayback() {
    if (state.kind === 'idle') {
      setStatus("Waiting for the guide to go live…", 'idle');
      showFallback('Waiting for the guide to go live…', '<a class="btn" href="/tours/' + encodeURIComponent(tour.slug) + '">Tour details</a>');
      return;
    }
    if (state.kind === 'ended') {
      setStatus('This tour has ended', 'ended');
      var ctaEnded = '<a class="btn secondary" href="/tours/' + encodeURIComponent(tour.slug) + '">Back to tour</a>';
      if (state.hasReplay || tour.hasReplay) {
        ctaEnded = '<a class="btn" href="/watch/' + encodeURIComponent(tour.slug) + '?replay=1">Watch the replay</a> ' + ctaEnded;
      }
      showFallback('This tour has ended.', ctaEnded);
      return;
    }

    var endpoint = state.kind === 'replay' ? '/replay' : '/playback';
    var label = state.kind === 'replay' ? 'Replay' : 'Connecting…';
    setStatus(label, state.kind === 'replay' ? 'replay' : 'idle');

    try {
      var res = await api('/v1/streams/' + state.streamId + endpoint);
      if (res.status === 401) { location.href = '/login?return_to=' + encodeURIComponent(location.pathname); return; }
      if (res.status === 402) { showFallback('Subscribe to watch this tour.', '<a class="btn" href="/pricing/">See plans</a>'); return; }
      if (res.status === 404 && state.kind === 'replay') { showFallback('Recording is still processing — check back shortly.'); return; }
      if (!res.ok) { showFallback('Could not load the stream right now. Please try again.'); return; }
      var json = await res.json();
      attachHls(json.hls_url);
      setStatus(state.kind === 'replay' ? 'Replay' : 'Live now', state.kind === 'replay' ? 'replay' : 'live');
      hideFallback();
    } catch (err) {
      showFallback('Network error — please retry.');
    }
  }

  var ws = null;
  function openWs() {
    if (!state.streamId || (state.kind !== 'live' && state.kind !== 'idle')) return;
    var proto = apiBase.indexOf('https') === 0 ? 'wss://' : 'ws://';
    var host = apiBase.replace(/^https?:\/\//, '');
    try {
      ws = new WebSocket(proto + host + '/v1/streams/' + state.streamId + '/socket');
    } catch (_) { return; }
    ws.addEventListener('message', function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'hello') {
        if (typeof msg.viewer_count === 'number') setViewerCount(msg.viewer_count);
        if (msg.status === 'live') {
          if (state.kind === 'idle' && state.streamId) {
            state = { kind: 'live', streamId: state.streamId };
            setStatus('Live now', 'live');
            startPlayback();
          } else {
            setStatus('Live now', 'live');
          }
        }
        if (msg.status === 'ended') onEnded();
      } else if (msg.type === 'viewer_count' && typeof msg.viewer_count === 'number') {
        setViewerCount(msg.viewer_count);
      } else if (msg.type === 'status') {
        if (msg.status === 'live') {
          if (state.kind === 'idle' && state.streamId) state = { kind: 'live', streamId: state.streamId };
          setStatus('Live now', 'live');
          startPlayback();
        } else if (msg.status === 'ended') { onEnded(); }
      } else if (msg.type === 'chat') {
        appendChat(msg);
      }
    });
    ws.addEventListener('close', function () {
      if (state.kind === 'live' || state.kind === 'idle') setTimeout(openWs, 4000);
    });
  }

  function onEnded() {
    var hadReplay = (state && state.hasReplay) || !!tour.hasReplay;
    var endedStreamId = state && state.streamId;
    state = { kind: 'ended', streamId: endedStreamId, hasReplay: hadReplay };
    setStatus('This tour has ended', 'ended');
    if (hls) try { hls.destroy(); } catch (_) {}
    try { videoEl.pause(); } catch (_) {}
    var cta = '<a class="btn secondary" href="/tours/' + encodeURIComponent(tour.slug) + '">Back to tour</a>';
    if (hadReplay) cta = '<a class="btn" href="/watch/' + encodeURIComponent(tour.slug) + '?replay=1">Watch replay</a> ' + cta;
    showFallback('This tour has ended.', cta);
  }

  function appendChat(msg) {
    var row = document.createElement('div');
    row.className = 'row';
    var from = document.createElement('span');
    from.className = 'from';
    from.textContent = (msg.role === 'guide' ? '🎙 ' : '') + (msg.from || 'guest').slice(0, 8);
    var text = document.createElement('span');
    text.textContent = ' ' + String(msg.text || '');
    row.appendChild(from); row.appendChild(text);
    chatList.appendChild(row);
    while (chatList.children.length > 60) chatList.removeChild(chatList.firstChild);
    chatList.scrollTop = chatList.scrollHeight;

    if (vrChatText && vrChatText.setAttribute) {
      var line = ((msg.role === 'guide' ? 'GUIDE ' : '') +
                  (msg.from || 'guest').slice(0, 8) + ': ' +
                  String(msg.text || '')).slice(0, 120);
      vrChatBuffer.push(line);
      while (vrChatBuffer.length > 6) vrChatBuffer.shift();
      vrChatText.setAttribute('value', vrChatBuffer.slice().reverse().join('\n'));
    }
  }

  if (chatForm) {
    chatForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = (chatInput.value || '').trim();
      if (!text || !ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'chat', text: text }));
      chatInput.value = '';
    });
  }

  startPlayback();
  openWs();

  var scene = document.getElementById('watch-scene');
  if (scene) scene.addEventListener('renderer-error', function () {
    showFallback('Your browser does not support 3D rendering for this tour.');
  });
})();
