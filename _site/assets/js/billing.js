/* eslint-disable */
/**
 * Billing client.
 *
 * Two surfaces:
 *  - data-auth-page="dashboard-billing" — Connect onboarding + Customer Portal
 *  - public pages with [data-plan] (pricing.html) or [data-book-tour]
 *    (server-rendered tour pages) — kicks off Stripe Checkout for that target.
 *
 * All API calls go through window.TourCoasterAuth.api when available so the
 * CF_Authorization cookie is sent. Buttons that require auth route the user
 * through /login first when no session is present.
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

  function setBanner(id, text, kind) {
    var b = document.getElementById(id);
    if (!b) { alert(text); return; }
    b.className = 'alert alert-' + kind + ' mt-3';
    b.textContent = text;
    b.classList.remove('d-none');
  }

  async function postJson(path, body) {
    var res = await api(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : '{}',
    });
    if (res.status === 401 || res.status === 403) {
      // Not signed in — bounce through /login with returnTo so we come back here.
      var ret = encodeURIComponent(location.pathname + location.search);
      location.href = '/login?return_to=' + ret;
      return null;
    }
    var json;
    try { json = await res.json(); } catch (_) { json = null; }
    if (!res.ok) {
      var msg = (json && json.error && json.error.message) || ('Request failed (' + res.status + ').');
      throw new Error(msg);
    }
    return json;
  }

  function redirectToStripe(json) {
    if (json && json.url) location.href = json.url;
    else throw new Error('Stripe did not return a URL.');
  }

  // -------------------------------------------------------------------------
  // Public buttons: subscribe / book.
  // -------------------------------------------------------------------------

  function bindPlanButtons() {
    document.querySelectorAll('[data-plan]').forEach(function (btn) {
      btn.disabled = false;
      btn.removeAttribute('title');
      btn.addEventListener('click', async function () {
        var plan = btn.getAttribute('data-plan');
        var prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Redirecting…';
        try {
          var json = await postJson('/v1/checkout/subscription', { plan: plan });
          if (json) redirectToStripe(json);
        } catch (e) {
          alert(e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = prev;
        }
      });
    });
  }

  function bindBookButtons() {
    document.querySelectorAll('[data-book-tour], [data-book-tour-slug]').forEach(function (btn) {
      btn.addEventListener('click', async function (ev) {
        ev.preventDefault();
        var tourId = btn.getAttribute('data-book-tour');
        var slug = btn.getAttribute('data-book-tour-slug');
        if (!tourId && !slug) return;
        var prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Redirecting…';
        try {
          var payload = tourId ? { tour_id: tourId } : { slug: slug };
          var json = await postJson('/v1/checkout/in-person', payload);
          if (json) redirectToStripe(json);
        } catch (e) {
          alert(e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = prev;
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard billing page.
  // -------------------------------------------------------------------------

  function setPayoutsBadge(text, color) {
    var b = document.getElementById('payouts-status-badge');
    if (!b) return;
    b.textContent = text;
    b.className = 'badge bg-' + color;
  }

  async function loadDashboardBilling() {
    var statusEl = document.getElementById('billing-status');
    var meRes = await api('/v1/me');
    if (meRes.status === 401) {
      var ret = encodeURIComponent(location.pathname);
      location.href = '/login?return_to=' + ret;
      return;
    }
    if (!meRes.ok) {
      statusEl.textContent = 'Could not load your account.';
      return;
    }
    var me = await meRes.json();
    statusEl.style.display = 'none';
    document.getElementById('subscription-card').style.display = '';
    if (me.role === 'guide') {
      document.getElementById('payouts-card').style.display = '';
      var enabled = me.profile && me.profile.charges_enabled;
      var hasAcct = me.profile && me.profile.stripe_account_id;
      if (enabled) {
        setPayoutsBadge('payouts enabled', 'success');
        document.getElementById('connect-onboard-btn').textContent = 'Update payout details';
      } else if (hasAcct) {
        setPayoutsBadge('action required', 'warning');
        document.getElementById('connect-onboard-btn').textContent = 'Continue Stripe onboarding';
      } else {
        setPayoutsBadge('not connected', 'secondary');
      }
      document.getElementById('connect-refresh-btn').style.display = hasAcct ? '' : 'none';

      // Returning from Stripe? Auto-refresh status so charges_enabled flips.
      if (new URLSearchParams(location.search).get('connect') === 'return') {
        try { await postJson('/v1/billing/connect/refresh', {}); location.replace('/dashboard/billing/'); } catch (_) {}
      }
    }

    document.getElementById('connect-onboard-btn').addEventListener('click', async function () {
      try {
        var json = await postJson('/v1/billing/connect/onboard', {});
        if (json) redirectToStripe(json);
      } catch (e) { setBanner('billing-banner', e.message, 'danger'); }
    });
    document.getElementById('connect-refresh-btn').addEventListener('click', async function () {
      try {
        var json = await postJson('/v1/billing/connect/refresh', {});
        setBanner(
          'billing-banner',
          json && json.charges_enabled ? 'Payouts are enabled.' : 'Stripe still needs more info.',
          json && json.charges_enabled ? 'success' : 'warning'
        );
      } catch (e) { setBanner('billing-banner', e.message, 'danger'); }
    });
    document.getElementById('portal-btn').addEventListener('click', async function () {
      try {
        var json = await postJson('/v1/billing/portal', {});
        if (json) redirectToStripe(json);
      } catch (e) { setBanner('billing-banner', e.message, 'danger'); }
    });
  }

  // -------------------------------------------------------------------------
  // Boot.
  // -------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body && document.body.getAttribute('data-auth-page');
    bindPlanButtons();
    bindBookButtons();
    if (page === 'dashboard-billing') {
      loadDashboardBilling().catch(function (err) {
        console.error(err);
        var s = document.getElementById('billing-status');
        if (s) s.textContent = 'Could not load billing.';
      });
    }
  });
})();
