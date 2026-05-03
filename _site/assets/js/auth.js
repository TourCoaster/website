/* eslint-disable */
/**
 * TourCoaster auth client.
 *
 * Cloudflare Access fronts both api.tourcoaster.com and the protected site
 * routes (/dashboard/*, /watch/*). Visiting any protected URL triggers the
 * Access flow, which redirects to Google, drops the CF_Authorization cookie
 * on tourcoaster.com, and returns the user to where they started.
 *
 * After return, this script:
 *   1. calls GET /v1/me using credentials: 'include' so the cookie is sent;
 *   2. if `role` is null, shows the role-pick UI on /login or /signup;
 *   3. otherwise redirects authenticated users to /dashboard/.
 *
 * For local development, override the API base by setting
 *   window.TOURCOASTER_API_BASE = 'http://localhost:8787'
 * before this script loads.
 */
(function () {
  'use strict';

  var API_BASE =
    window.TOURCOASTER_API_BASE ||
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '0.0.0.0'
      ? 'http://localhost:8787'
      : 'https://api.tourcoaster.com');

  function api(path, init) {
    init = init || {};
    init.credentials = 'include';
    init.headers = Object.assign(
      { Accept: 'application/json' },
      init.body ? { 'Content-Type': 'application/json' } : {},
      init.headers || {}
    );
    return fetch(API_BASE + path, init);
  }

  async function getMe() {
    var res = await api('/v1/me');
    if (res.status === 401) return { authenticated: false };
    if (!res.ok) throw new Error('me_failed_' + res.status);
    var body = await res.json();
    return { authenticated: true, user: body };
  }

  async function setRole(role) {
    var res = await api('/v1/auth/role', {
      method: 'POST',
      body: JSON.stringify({ role: role }),
    });
    if (!res.ok) {
      var err;
      try { err = await res.json(); } catch (e) { err = null; }
      throw new Error((err && err.error && err.error.code) || 'role_failed');
    }
    return res.json();
  }

  async function signOut() {
    try {
      await api('/v1/auth/logout', { method: 'POST' });
    } catch (e) {
      // best effort
    }
    // Terminate the Access session globally and bounce home.
    var teamDomain = window.TOURCOASTER_CF_TEAM;
    if (teamDomain) {
      location.href = 'https://' + teamDomain + '/cdn-cgi/access/logout';
    } else {
      location.href = '/';
    }
  }

  // Trigger the CF Access login flow by navigating to a protected URL.
  function signIn(returnTo) {
    var dest = returnTo || '/dashboard/';
    location.href = dest;
  }

  // ----- Page-specific wiring ---------------------------------------------

  function wireSignInButtons() {
    var ids = ['google-signin', 'google-signup'];
    ids.forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false;
      btn.removeAttribute('title');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        signIn('/dashboard/');
      });
    });
  }

  function renderRolePicker(container, onPicked) {
    container.innerHTML =
      '<h3 class="mb-3">One last step</h3>' +
      '<p class="text-muted mb-4">How will you use TourCoaster?</p>' +
      '<div class="d-grid gap-2">' +
        '<button type="button" class="btn btn-primary btn-lg rounded-pill" data-role="traveler">' +
          'I\'m a traveler' +
        '</button>' +
        '<button type="button" class="btn btn-outline-primary btn-lg rounded-pill" data-role="guide">' +
          'I\'m a guide' +
        '</button>' +
      '</div>' +
      '<p id="role-error" class="text-danger small mt-3" style="display:none;"></p>';

    container.querySelectorAll('button[data-role]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        container.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        var errEl = container.querySelector('#role-error');
        errEl.style.display = 'none';
        try {
          await setRole(btn.getAttribute('data-role'));
          onPicked();
        } catch (e) {
          errEl.textContent = 'Could not save your role. Please try again.';
          errEl.style.display = 'block';
          container.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        }
      });
    });
  }

  async function bootstrapAuthPage() {
    var card = document.querySelector('[data-auth-card]');
    if (!card) {
      wireSignInButtons();
      return;
    }

    try {
      var result = await getMe();
      if (!result.authenticated) {
        wireSignInButtons();
        return;
      }
      if (result.user.role == null) {
        renderRolePicker(card, function () { location.href = '/dashboard/'; });
        return;
      }
      location.href = '/dashboard/';
    } catch (e) {
      wireSignInButtons();
    }
  }

  async function bootstrapDashboard() {
    var greeting = document.querySelector('[data-auth-greeting]');
    var signOutBtn = document.querySelector('[data-auth-signout]');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', function (e) {
        e.preventDefault();
        signOut();
      });
    }

    try {
      var result = await getMe();
      if (!result.authenticated) {
        location.href = '/login';
        return;
      }
      if (result.user.role == null) {
        location.href = '/login';
        return;
      }
      if (greeting) {
        greeting.textContent = 'Signed in as ' + result.user.email + ' (' + result.user.role + ')';
      }
    } catch (e) {
      // Keep the placeholder content; show a small notice.
      if (greeting) greeting.textContent = 'Could not reach the API.';
    }
  }

  window.TourCoasterAuth = {
    api: api,
    getMe: getMe,
    setRole: setRole,
    signIn: signIn,
    signOut: signOut,
  };

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.getAttribute('data-auth-page');
    if (page === 'login' || page === 'signup') bootstrapAuthPage();
    else if (page === 'dashboard') bootstrapDashboard();
  });
})();
