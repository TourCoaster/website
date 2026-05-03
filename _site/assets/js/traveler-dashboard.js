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

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
  }

  function showError(msg) {
    var el = document.getElementById('td-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('d-none');
  }

  function setEmpty(containerId, msg) {
    var el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div class="col-12"><p class="td-empty mb-0">' + esc(msg) + '</p></div>';
  }

  // -------------------- Bookings + ICS --------------------

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function icsDate(iso) {
    var d = new Date(iso);
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  function icsEscape(s) { return String(s || '').replace(/[\\,;]/g, '\\$&').replace(/\n/g, '\\n'); }

  function buildIcs(b) {
    var start = b.scheduled_at ? icsDate(b.scheduled_at) : null;
    if (!start) return null;
    var endIso = new Date(new Date(b.scheduled_at).getTime() + 60 * 60 * 1000).toISOString();
    var end = icsDate(endIso);
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TourCoaster//Booking//EN',
      'BEGIN:VEVENT',
      'UID:tourcoaster-booking-' + b.id + '@tourcoaster.com',
      'DTSTAMP:' + icsDate(new Date().toISOString()),
      'DTSTART:' + start,
      'DTEND:' + end,
      'SUMMARY:' + icsEscape(b.tour_title),
      'LOCATION:' + icsEscape(b.tour_location || ''),
      'DESCRIPTION:' + icsEscape('Guide: ' + (b.guide_display_name || 'TBA') + '\nView: ' + location.origin + '/tours/' + b.tour_slug),
      'URL:' + location.origin + '/tours/' + b.tour_slug,
      'END:VEVENT',
      'END:VCALENDAR',
    ];
    return lines.join('\r\n');
  }

  function downloadIcs(b) {
    var ics = buildIcs(b);
    if (!ics) return;
    var blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'tourcoaster-' + b.id + '.ics';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function loadBookings() {
    var el = document.getElementById('td-bookings');
    try {
      var res = await api('/v1/bookings/me');
      if (!res.ok) throw new Error('http ' + res.status);
      var json = await res.json();
      var list = json.upcoming || [];
      if (list.length === 0) { setEmpty('td-bookings', 'No upcoming bookings yet.'); return; }
      el.innerHTML = list.map(function (b) {
        var when = b.scheduled_at ? fmtDate(b.scheduled_at) : 'Date TBA';
        return '<div class="col-md-6"><div class="td-card">' +
          '<div class="d-flex justify-content-between align-items-start">' +
          '<div>' +
          '<div class="fw-semibold"><a href="/tours/' + esc(b.tour_slug) + '">' + esc(b.tour_title) + '</a></div>' +
          '<div class="small text-muted">' + esc(when) + (b.tour_location ? ' · ' + esc(b.tour_location) : '') + '</div>' +
          '<div class="small text-muted">Guide: ' + esc(b.guide_display_name || 'TBA') + '</div>' +
          '</div>' +
          (b.scheduled_at ? '<button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" data-ics="' + esc(b.id) + '">.ics</button>' : '') +
          '</div></div></div>';
      }).join('');
      el.querySelectorAll('[data-ics]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-ics');
          var b = list.find(function (x) { return x.id === id; });
          if (b) downloadIcs(b);
        });
      });
    } catch (_) { setEmpty('td-bookings', 'Could not load bookings.'); }
  }

  // -------------------- Live now --------------------

  async function loadLive() {
    var el = document.getElementById('td-live');
    el.innerHTML = '<div class="col-12"><div class="td-skeleton" style="height:120px;"></div></div>';
    try {
      var res = await api('/v1/streams/live');
      if (!res.ok) throw new Error('http ' + res.status);
      var json = await res.json();
      var list = json.items || [];
      if (list.length === 0) { setEmpty('td-live', 'No tours are live right now.'); return; }
      el.innerHTML = list.map(function (s) {
        return '<div class="col-md-6 col-lg-4"><div class="td-card">' +
          '<div class="d-flex align-items-center mb-2"><span class="badge bg-danger me-2">LIVE</span>' +
          '<span class="small text-muted">' + esc(fmtDate(s.started_at)) + '</span></div>' +
          '<div class="fw-semibold mb-1">' + esc(s.title) + '</div>' +
          '<div class="small text-muted mb-2">' + esc(s.guide_display_name || '') + (s.location ? ' · ' + esc(s.location) : '') + '</div>' +
          '<a class="btn btn-sm btn-primary rounded-pill" href="/watch/' + esc(s.slug) + '">Watch</a>' +
          '</div></div>';
      }).join('');
    } catch (_) { setEmpty('td-live', 'Could not load live tours.'); }
  }

  // -------------------- Subscription --------------------

  async function loadSubscription(me) {
    var el = document.getElementById('td-subscription');
    var sub = me && me.subscription;
    if (!sub) {
      el.innerHTML =
        '<h3 class="h6 mb-2">No active subscription</h3>' +
        '<p class="text-muted small mb-3">Subscribe to watch unlimited live VR tours.</p>' +
        '<a class="btn btn-primary rounded-pill" href="/pricing">See plans</a>';
      return;
    }
    var nextBill = sub.current_period_end ? fmtDate(sub.current_period_end) : '—';
    el.innerHTML =
      '<div class="d-flex flex-wrap justify-content-between align-items-start gap-3">' +
      '<div>' +
      '<div class="text-muted small">Plan</div>' +
      '<div class="h5 mb-2">' + esc(sub.plan || '—') + ' <span class="badge bg-secondary ms-1">' + esc(sub.status || '') + '</span></div>' +
      '<div class="text-muted small">Next billing date</div>' +
      '<div>' + esc(nextBill) + (sub.cancel_at_period_end ? ' <span class="text-warning small">(cancels at period end)</span>' : '') + '</div>' +
      '</div>' +
      '<button type="button" class="btn btn-outline-secondary rounded-pill" id="td-portal-btn">Manage billing</button>' +
      '</div>';
    var btn = document.getElementById('td-portal-btn');
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      try {
        var res = await api('/v1/billing/portal', { method: 'POST' });
        var json = await res.json();
        if (!res.ok) throw new Error((json && json.error && json.error.message) || 'portal_failed');
        location.href = json.url;
      } catch (e) {
        showError('Could not open billing portal: ' + e.message);
        btn.disabled = false;
      }
    });
  }

  async function fetchSubscription() {
    try {
      var res = await api('/v1/me');
      if (!res.ok) return null;
      var me = await res.json();
      // /v1/me may not include `subscription` yet; try a dedicated lookup.
      if (me.subscription) return me;
      var sres = await api('/v1/billing/subscription');
      if (sres.ok) {
        var sjson = await sres.json();
        me.subscription = sjson.subscription || sjson || null;
      }
      return me;
    } catch (_) { return null; }
  }

  // -------------------- History --------------------

  async function loadHistory() {
    var el = document.getElementById('td-history');
    try {
      var res = await api('/v1/history/me');
      if (!res.ok) throw new Error('http ' + res.status);
      var json = await res.json();
      var list = json.items || [];
      if (list.length === 0) { setEmpty('td-history', 'No past tours yet.'); return; }
      el.innerHTML = list.map(function (h) {
        var replay = h.has_replay
          ? '<a class="btn btn-sm btn-outline-primary rounded-pill" href="/watch/' + esc(h.slug) + '?replay=1">Watch replay</a>'
          : '<span class="small text-muted">Replay unavailable</span>';
        return '<div class="col-md-6"><div class="td-card d-flex justify-content-between align-items-center">' +
          '<div>' +
          '<div class="fw-semibold"><a href="/tours/' + esc(h.slug) + '">' + esc(h.title) + '</a></div>' +
          '<div class="small text-muted">' + esc(h.location || '') + ' · ' + esc(fmtDate(h.last_seen_at)) + '</div>' +
          '</div>' + replay + '</div></div>';
      }).join('');
    } catch (_) { setEmpty('td-history', 'Could not load history.'); }
  }

  // -------------------- Wishlist --------------------

  function mediaUrl(key) {
    if (!key) return '/assets/img/placeholder.jpg';
    return API_BASE + '/v1/media/' + encodeURIComponent(key);
  }

  function fmtPrice(cents, currency) {
    if (cents == null) return '';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' })
        .format(cents / 100);
    } catch (_) { return (cents / 100).toFixed(2) + ' ' + (currency || 'USD'); }
  }

  async function loadWishlist() {
    var el = document.getElementById('td-wishlist');
    try {
      var res = await api('/v1/wishlist');
      if (!res.ok) throw new Error('http ' + res.status);
      var json = await res.json();
      var list = json.items || [];
      if (list.length === 0) {
        el.innerHTML = '<div class="col-12"><p class="td-empty mb-0">Save tours you want to watch later — they\'ll appear here.</p></div>';
        return;
      }
      el.innerHTML = list.map(function (w) {
        return '<div class="col-md-6 col-lg-4"><div class="td-card">' +
          '<img src="' + esc(mediaUrl(w.cover_key)) + '" alt="" class="rounded mb-2" style="width:100%;height:140px;object-fit:cover;" loading="lazy">' +
          '<div class="fw-semibold"><a href="/tours/' + esc(w.slug) + '">' + esc(w.title) + '</a></div>' +
          '<div class="small text-muted mb-2">' + esc(w.location || '') + ' · ' + esc(fmtPrice(w.price_cents, w.currency)) + '</div>' +
          '<button type="button" class="btn btn-sm btn-outline-danger rounded-pill" data-unsave="' + esc(w.tour_id) + '">Remove</button>' +
          '</div></div>';
      }).join('');
      el.querySelectorAll('[data-unsave]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var id = btn.getAttribute('data-unsave');
          btn.disabled = true;
          try {
            var r = await api('/v1/wishlist/' + encodeURIComponent(id), { method: 'DELETE' });
            if (!r.ok) throw new Error('http ' + r.status);
            loadWishlist();
          } catch (_) {
            btn.disabled = false;
            showError('Could not remove from wishlist.');
          }
        });
      });
    } catch (_) { setEmpty('td-wishlist', 'Could not load wishlist.'); }
  }

  // -------------------- Bootstrap --------------------

  document.addEventListener('DOMContentLoaded', async function () {
    if (document.body.getAttribute('data-auth-page') !== 'dashboard') return;

    var meRes;
    try { meRes = await api('/v1/me'); } catch (_) {}
    if (!meRes || meRes.status === 401) {
      location.href = '/login?return_to=' + encodeURIComponent(location.pathname);
      return;
    }
    if (!meRes.ok) { showError('Could not load your account.'); return; }
    var me = await meRes.json();

    if (me.role === 'guide' || me.role === 'admin') {
      var g = document.querySelector('[data-role="guide"]');
      if (g) g.style.display = '';
      return;
    }

    var t = document.querySelector('[data-role="traveler"]');
    if (t) t.style.display = '';

    loadBookings();
    loadLive();
    loadHistory();
    loadWishlist();
    fetchSubscription().then(function (m) { loadSubscription(m || me); });

    var refresh = document.getElementById('td-live-refresh');
    if (refresh) refresh.addEventListener('click', loadLive);
  });
})();
