/* eslint-disable */
/**
 * Guide profile editor on /dashboard/profile/.
 *
 * Loads /v1/guides/me, renders form values, PATCHes on submit, and runs the
 * presigned avatar upload flow on file pick:
 *   1. POST /v1/guides/me/avatar { contentType }  →  { uploadUrl, key }
 *      (the server persists avatar_key on the guide's profile in this call)
 *   2. PUT <uploadUrl>  with the file bytes
 *   3. GET /v1/guides/me  to refresh the form with the new key
 *
 * Depends on /assets/js/auth.js for window.TourCoasterAuth.api.
 */
(function () {
  'use strict';

  if (document.body.getAttribute('data-auth-page') !== 'dashboard-profile') return;

  document.addEventListener('DOMContentLoaded', function () {
    bootstrap().catch(function (err) {
      console.error(err);
      setStatus('Could not load your profile.', 'danger', /*persistent*/ true);
    });
  });

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

  var form, statusEl, banner, avatarPreview, avatarInput, publicUrlEl, approvalNote;
  var currentProfile = null;

  function setStatus(text, kind, persistent) {
    if (!banner) return;
    banner.className = 'alert alert-' + kind;
    banner.textContent = text;
    banner.classList.remove('d-none');
    if (!persistent) {
      setTimeout(function () { banner.classList.add('d-none'); }, 4000);
    }
  }

  function showLoading(text) {
    statusEl.textContent = text;
    statusEl.style.display = '';
  }
  function hideLoading() { statusEl.style.display = 'none'; }

  function avatarUrl(key) {
    if (!key) return '/assets/images/avatar.webp';
    return apiBase + '/v1/media/' + key.split('/').map(encodeURIComponent).join('/');
  }

  function fillForm(p) {
    currentProfile = p;
    form.display_name.value = p.display_name || '';
    form.slug.value = p.slug || '';
    form.location.value = p.location || '';
    form.languages.value = (p.languages || []).join(', ');
    form.bio.value = p.bio || '';
    avatarPreview.src = avatarUrl(p.avatar_key);
    publicUrlEl.textContent = '/guides/' + p.slug;
    approvalNote.style.display = p.status === 'approved' ? 'none' : '';
  }

  async function loadProfile() {
    var res = await api('/v1/guides/me');
    if (res.status === 401 || res.status === 403) {
      location.href = '/login';
      return null;
    }
    if (!res.ok) throw new Error('load_failed_' + res.status);
    return await res.json();
  }

  async function saveProfile(patch) {
    var res = await api('/v1/guides/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      var err;
      try { err = await res.json(); } catch (_) { err = null; }
      var code = err && err.error && err.error.code;
      var msg =
        code === 'slug_taken' ? 'That slug is already taken — try another.' :
        code === 'invalid_slug' ? 'Slug must be lowercase letters, numbers, and dashes.' :
        (err && err.error && err.error.message) || 'Could not save.';
      throw new Error(msg);
    }
    return await res.json();
  }

  async function uploadAvatar(file) {
    if (file.size > 5 * 1024 * 1024) throw new Error('Avatar is too large (max 5 MB).');
    var allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.indexOf(file.type) === -1) throw new Error('Use a JPEG, PNG, or WebP image.');

    var presignRes = await api('/v1/guides/me/avatar', {
      method: 'POST',
      body: JSON.stringify({ contentType: file.type }),
    });
    if (!presignRes.ok) {
      var err;
      try { err = await presignRes.json(); } catch (_) { err = null; }
      throw new Error((err && err.error && err.error.message) || 'Could not start avatar upload.');
    }
    var presign = await presignRes.json();

    var putRes = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!putRes.ok) throw new Error('Upload failed (' + putRes.status + ').');

    // The avatar_key is already persisted server-side by POST /v1/guides/me/avatar.
    // Re-fetch the profile so the form picks up the new key + cache-busted preview.
    var refreshed = await api('/v1/guides/me');
    return refreshed.ok ? await refreshed.json() : Object.assign({}, currentProfile, { avatar_key: presign.key });
  }

  function parseLanguages(raw) {
    return raw
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function bindForm() {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var saveBtn = document.getElementById('save-btn');
      saveBtn.disabled = true;
      var prevText = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      try {
        var patch = {
          display_name: form.display_name.value.trim() || null,
          slug: form.slug.value.trim(),
          location: form.location.value.trim() || null,
          languages: parseLanguages(form.languages.value),
          bio: form.bio.value || null,
        };
        var updated = await saveProfile(patch);
        fillForm(updated);
        setStatus('Profile saved.', 'success');
      } catch (err) {
        setStatus(err.message || 'Could not save.', 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = prevText;
      }
    });

    avatarInput.addEventListener('change', async function () {
      var file = avatarInput.files && avatarInput.files[0];
      if (!file) return;
      avatarInput.disabled = true;
      try {
        var updated = await uploadAvatar(file);
        fillForm(updated);
        setStatus('Avatar updated.', 'success');
      } catch (err) {
        setStatus(err.message || 'Could not upload avatar.', 'danger');
      } finally {
        avatarInput.disabled = false;
        avatarInput.value = '';
      }
    });
  }

  async function bootstrap() {
    statusEl = document.getElementById('profile-status');
    form = document.getElementById('profile-form');
    banner = document.getElementById('status-banner');
    avatarPreview = document.getElementById('avatar-preview');
    avatarInput = document.getElementById('avatar-input');
    publicUrlEl = document.querySelector('[data-public-url]');
    approvalNote = document.getElementById('approval-note');

    showLoading('Loading your profile…');

    var profile = await loadProfile();
    if (!profile) return;

    fillForm(profile);
    hideLoading();
    form.style.display = '';
    bindForm();
  }
})();
