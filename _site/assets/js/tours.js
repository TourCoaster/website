/* eslint-disable */
/**
 * Tours dashboard + browse client.
 *
 * Three pages, dispatched by document.body[data-auth-page]:
 *  - dashboard-tours       /dashboard/tours/         list owner's tours
 *  - dashboard-tour-edit   /dashboard/tours/edit/    create/edit a single tour
 *  - browse                /explore                  public listing (hydrates)
 */
(function () {
  'use strict';

  var page = document.body && document.body.getAttribute('data-auth-page');
  var browseGrid = document.getElementById('browse-grid');

  var apiBase =
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
    return fetch(apiBase + path, init);
  }

  function publicFetch(path) {
    return fetch(apiBase + path, { headers: { Accept: 'application/json' } });
  }

  function mediaUrl(key) {
    if (!key) return null;
    return apiBase + '/v1/media/' + key.split('/').map(encodeURIComponent).join('/');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function formatPrice(cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: currency === 'JPY' ? 0 : 2,
      }).format((cents || 0) / 100);
    } catch (_) {
      return (currency || 'USD') + ' ' + ((cents || 0) / 100).toFixed(2);
    }
  }

  // -------------------------------------------------------------------------
  // Page: dashboard-tours (list)
  // -------------------------------------------------------------------------
  if (page === 'dashboard-tours') {
    document.addEventListener('DOMContentLoaded', function () {
      loadList().catch(function (err) {
        console.error(err);
        document.getElementById('tours-status').textContent = 'Could not load your tours.';
      });
    });
  }

  async function loadList() {
    var statusEl = document.getElementById('tours-status');
    var listEl = document.getElementById('tours-list');
    var emptyEl = document.getElementById('tours-empty');

    var res = await api('/v1/tours/mine');
    if (res.status === 401 || res.status === 403) { location.href = '/login'; return; }
    if (!res.ok) throw new Error('mine_failed_' + res.status);
    var data = await res.json();
    statusEl.style.display = 'none';

    if (!data.tours || data.tours.length === 0) {
      emptyEl.style.display = '';
      return;
    }

    listEl.style.display = '';
    listEl.innerHTML = data.tours.map(function (t) {
      var statusColor = t.status === 'published' ? 'success' : 'secondary';
      return (
        '<div class="col-12">' +
          '<div class="card p-3 d-flex flex-row align-items-center justify-content-between flex-wrap gap-2">' +
            '<div>' +
              '<a href="/dashboard/tours/edit/?id=' + encodeURIComponent(t.id) + '" class="h5 mb-1 d-block">' +
                escapeHtml(t.title) + '</a>' +
              '<span class="badge bg-' + statusColor + ' me-2">' + escapeHtml(t.status) + '</span>' +
              '<span class="text-muted small">' + escapeHtml(t.location || '—') + ' · ' + escapeHtml(t.category || '—') + '</span>' +
            '</div>' +
            '<div class="d-flex gap-2">' +
              (t.status === 'published'
                ? '<a href="/tours/' + encodeURIComponent(t.slug) + '" class="btn btn-sm btn-outline-secondary rounded-pill">View</a>'
                : '') +
              '<a href="/dashboard/tours/edit/?id=' + encodeURIComponent(t.id) + '" class="btn btn-sm btn-primary rounded-pill">Edit</a>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  // -------------------------------------------------------------------------
  // Page: dashboard-tour-edit
  // -------------------------------------------------------------------------
  if (page === 'dashboard-tour-edit') {
    document.addEventListener('DOMContentLoaded', function () {
      bootEdit().catch(function (err) {
        console.error(err);
        document.getElementById('tour-status').textContent = err.message || 'Could not load tour.';
      });
    });
  }

  function setBanner(text, kind) {
    var b = document.getElementById('status-banner');
    if (!b) return;
    b.className = 'alert alert-' + kind;
    b.textContent = text;
    b.classList.remove('d-none');
    setTimeout(function () { b.classList.add('d-none'); }, 4000);
  }

  async function bootEdit() {
    var qs = new URLSearchParams(location.search);
    var id = qs.get('id');
    var statusEl = document.getElementById('tour-status');
    var form = document.getElementById('tour-form');

    var tour;
    if (!id || id === 'new') {
      var title = (prompt('Title for the new tour:') || '').trim();
      if (title.length < 3) { location.href = '/dashboard/tours/'; return; }
      var createRes = await api('/v1/tours', { method: 'POST', body: JSON.stringify({ title: title }) });
      if (createRes.status === 401 || createRes.status === 403) { location.href = '/login'; return; }
      if (!createRes.ok) throw new Error('Could not create the tour.');
      tour = await createRes.json();
      history.replaceState(null, '', '/dashboard/tours/edit/?id=' + encodeURIComponent(tour.id));
    } else {
      var getRes = await api('/v1/tours/' + encodeURIComponent(id));
      if (getRes.status === 401 || getRes.status === 403) { location.href = '/login'; return; }
      if (!getRes.ok) throw new Error('Tour not found.');
      tour = await getRes.json();
    }

    statusEl.style.display = 'none';
    form.style.display = '';
    fillForm(tour);
    bindEdit(tour);
  }

  function fillForm(t) {
    document.getElementById('title').value = t.title || '';
    document.getElementById('slug').value = t.slug || '';
    document.getElementById('category').value = t.category || '';
    document.getElementById('location').value = t.location || '';
    document.getElementById('description').value = t.description || '';
    document.getElementById('duration_minutes').value = t.duration_minutes || '';
    document.getElementById('capacity').value = t.capacity || '';
    document.getElementById('price_cents').value = t.price_cents == null ? '' : t.price_cents;
    document.getElementById('currency').value = t.currency || 'USD';
    document.getElementById('vr_enabled').checked = !!t.vr_enabled;
    document.getElementById('scheduled_at').value = t.scheduled_at ? t.scheduled_at.slice(0, 16) : '';
    document.getElementById('scheduled-wrap').style.display = t.vr_enabled ? '' : 'none';

    var badge = document.getElementById('status-badge');
    badge.textContent = t.status;
    badge.className = 'badge bg-' + (t.status === 'published' ? 'success' : t.status === 'deleted' ? 'danger' : 'secondary');
    document.getElementById('updated-at').textContent = 'Updated ' + new Date(t.updated_at).toLocaleString();
    document.querySelector('[data-public-url]').textContent = '/tours/' + (t.slug || '…');
    document.getElementById('page-title').textContent = t.title || 'Edit Tour';

    renderMedia(t);
  }

  function renderMedia(t) {
    var grid = document.getElementById('media-grid');
    if ((t.media || []).length === 0) {
      grid.innerHTML = '<p class="text-muted small mb-0">No photos yet.</p>';
      return;
    }
    grid.innerHTML = t.media.map(function (m) {
      return (
        '<div style="position:relative;width:120px;height:120px;">' +
          '<img src="' + escapeHtml(mediaUrl(m.r2_key)) + '" alt="" ' +
               'style="width:120px;height:120px;object-fit:cover;border-radius:8px;">' +
          '<button type="button" class="btn btn-sm btn-danger" data-media-del="' + escapeHtml(m.id) + '" ' +
               'style="position:absolute;top:4px;right:4px;padding:0 6px;line-height:1.2;">×</button>' +
        '</div>'
      );
    }).join('');
  }

  function bindEdit(initialTour) {
    var tour = initialTour;
    var form = document.getElementById('tour-form');

    document.getElementById('vr_enabled').addEventListener('change', function (e) {
      document.getElementById('scheduled-wrap').style.display = e.target.checked ? '' : 'none';
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      await save();
    });

    document.getElementById('publish-btn').addEventListener('click', async function () {
      try {
        await save();
        var pubRes = await api('/v1/tours/' + encodeURIComponent(tour.id) + '/publish', { method: 'POST' });
        if (!pubRes.ok) {
          var err; try { err = await pubRes.json(); } catch (_) { err = null; }
          throw new Error((err && err.error && err.error.message) || 'Could not publish.');
        }
        tour = await pubRes.json();
        fillForm(tour);
        setBanner('Tour published.', 'success');
      } catch (e2) { setBanner(e2.message, 'danger'); }
    });

    document.getElementById('delete-btn').addEventListener('click', async function () {
      if (!confirm('Delete this tour? It will be hidden from public listings.')) return;
      var res = await api('/v1/tours/' + encodeURIComponent(tour.id), { method: 'DELETE' });
      if (res.ok) location.href = '/dashboard/tours/';
      else setBanner('Could not delete.', 'danger');
    });

    document.getElementById('media-grid').addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-media-del]');
      if (!btn) return;
      var mid = btn.getAttribute('data-media-del');
      btn.disabled = true;
      var res = await api('/v1/tours/' + encodeURIComponent(tour.id) + '/media/' + encodeURIComponent(mid), { method: 'DELETE' });
      if (res.ok) {
        tour.media = (tour.media || []).filter(function (m) { return m.id !== mid; });
        renderMedia(tour);
      } else {
        btn.disabled = false;
        setBanner('Could not delete photo.', 'danger');
      }
    });

    document.getElementById('media-input').addEventListener('change', async function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      e.target.disabled = true;
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('Photo is too large (max 10 MB).');
        var allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.indexOf(file.type) === -1) throw new Error('Use JPEG, PNG, or WebP.');
        var presignRes = await api('/v1/tours/' + encodeURIComponent(tour.id) + '/media', {
          method: 'POST', body: JSON.stringify({ contentType: file.type }),
        });
        if (!presignRes.ok) throw new Error('Could not start upload.');
        var p = await presignRes.json();
        var putRes = await fetch(p.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
        if (!putRes.ok) throw new Error('Upload failed.');
        var refresh = await api('/v1/tours/' + encodeURIComponent(tour.id));
        tour = await refresh.json();
        renderMedia(tour);
        setBanner('Photo added.', 'success');
      } catch (err) {
        setBanner(err.message, 'danger');
      } finally {
        e.target.disabled = false;
        e.target.value = '';
      }
    });

    async function save() {
      var saveBtn = document.getElementById('save-btn');
      saveBtn.disabled = true;
      var prev = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      try {
        var f = form;
        var sched = f.scheduled_at.value;
        var patch = {
          title: f.title.value.trim(),
          slug: f.slug.value.trim(),
          category: f.category.value || null,
          location: f.location.value.trim() || null,
          description: f.description.value || null,
          duration_minutes: f.duration_minutes.value ? parseInt(f.duration_minutes.value, 10) : null,
          capacity: f.capacity.value ? parseInt(f.capacity.value, 10) : null,
          price_cents: parseInt(f.price_cents.value || '0', 10),
          currency: f.currency.value,
          vr_enabled: f.vr_enabled.checked,
          scheduled_at: f.vr_enabled.checked && sched ? new Date(sched).toISOString() : null,
        };
        if (!patch.slug) delete patch.slug;
        var res = await api('/v1/tours/' + encodeURIComponent(tour.id), {
          method: 'PATCH', body: JSON.stringify(patch),
        });
        if (!res.ok) {
          var err; try { err = await res.json(); } catch (_) { err = null; }
          var code = err && err.error && err.error.code;
          var msg = code === 'slug_taken' ? 'That slug is already taken.' :
                    (err && err.error && err.error.message) || 'Could not save.';
          throw new Error(msg);
        }
        tour = await res.json();
        fillForm(tour);
        setBanner('Saved.', 'success');
      } catch (e2) {
        setBanner(e2.message, 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = prev;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Page: explore (browse hydration)
  // -------------------------------------------------------------------------
  if (browseGrid) {
    document.addEventListener('DOMContentLoaded', function () {
      hydrateBrowse().catch(function (err) {
        console.error(err);
        browseGrid.innerHTML = '<div class="col-12 text-center text-muted">Could not load tours right now.</div>';
      });
    });

    document.querySelectorAll('[data-browse-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-browse-filter]').forEach(function (b) {
          b.classList.remove('active', 'btn-primary');
          b.classList.add('btn-outline-primary');
        });
        btn.classList.add('active', 'btn-primary');
        btn.classList.remove('btn-outline-primary');
        var cat = btn.getAttribute('data-browse-filter');
        hydrateBrowse(cat === 'all' ? null : cat).catch(function () {});
      });
    });
  }

  async function hydrateBrowse(category) {
    browseGrid.innerHTML =
      '<div class="col-12"><p class="text-center text-muted py-4">Loading tours…</p></div>';
    var qs = '?limit=24';
    if (category) qs += '&category=' + encodeURIComponent(category);
    var res = await publicFetch('/v1/tours' + qs);
    if (!res.ok) throw new Error('list_failed_' + res.status);
    var data = await res.json();
    if (!data.tours || data.tours.length === 0) {
      browseGrid.innerHTML =
        '<div class="col-12 text-center text-muted py-4">No tours yet — check back soon!</div>';
      return;
    }
    browseGrid.innerHTML = data.tours.map(function (t) {
      var img = t.cover ? mediaUrl(t.cover) : '/assets/images/art/bg1.webp';
      return (
        '<div class="col-md-6 col-lg-4 mb-4">' +
          '<div class="card shadow-sm h-100">' +
            '<a href="/tours/' + encodeURIComponent(t.slug) + '">' +
              '<img src="' + escapeHtml(img) + '" alt="' + escapeHtml(t.title) + '" ' +
                   'style="width:100%;height:200px;object-fit:cover;">' +
            '</a>' +
            '<div class="card-body p-4">' +
              '<h5 class="mb-1"><a href="/tours/' + encodeURIComponent(t.slug) + '" class="text-dark">' +
                escapeHtml(t.title) + '</a></h5>' +
              '<p class="text-muted mb-2 small"><i class="jam jam-map-marker"></i> ' +
                escapeHtml(t.location || '') + '</p>' +
              '<p class="mb-3 small">' + escapeHtml((t.description || '').slice(0, 120)) + '</p>' +
              '<div class="d-flex justify-content-between align-items-center">' +
                '<span class="badge bg-light text-dark">' + escapeHtml(t.category || '') + '</span>' +
                '<strong>' + escapeHtml(formatPrice(t.price_cents, t.currency)) + '</strong>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }
})();
