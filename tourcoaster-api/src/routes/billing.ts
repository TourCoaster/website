import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { AppError } from '../middleware/error';
import { requireAccessAuth, requireRole } from '../auth/middleware';
import { stripeFetch } from '../stripe/api';

export const billingRoute = new Hono<AppEnv>();
billingRoute.use('*', requireAccessAuth());

const successOrigin = (env: AppEnv['Bindings']): string =>
  env.PUBLIC_SITE_ORIGIN || 'https://tourcoaster.com';

// ---------------------------------------------------------------------------
// Connect onboarding (guides only).
// POST /v1/billing/connect/onboard
//   Creates a Stripe Express account on first call (persisting
//   stripe_account_id on guide_profiles), then mints an AccountLink and
//   returns its URL. Front-end opens it in a top-level navigation.
// POST /v1/billing/connect/refresh
//   Re-reads the account from Stripe and persists charges_enabled. Called
//   after the user returns from Stripe (return_url) and from the
//   account.updated webhook.
// ---------------------------------------------------------------------------

billingRoute.post('/connect/onboard', requireRole('guide'), async (c) => {
  const user = c.get('user');
  const profileRow = await c.env.DB.prepare(
    `SELECT slug, stripe_account_id, charges_enabled FROM guide_profiles WHERE user_id = ?1`
  )
    .bind(user.id)
    .first<{ slug: string; stripe_account_id: string | null; charges_enabled: number }>();
  if (!profileRow) {
    throw new AppError(409, 'no_profile', 'Create your guide profile before connecting payouts.');
  }

  let acct = profileRow.stripe_account_id;
  if (!acct) {
    const created = await stripeFetch<{ id: string }>(c.env, '/v1/accounts', {
      body: {
        type: 'express',
        email: user.email,
        capabilities: {
          transfers: { requested: 'true' },
          card_payments: { requested: 'true' },
        },
        business_type: 'individual',
        metadata: { tourcoaster_user_id: user.id, tourcoaster_guide_slug: profileRow.slug },
      },
      idempotencyKey: `connect_create_${user.id}`,
    });
    acct = created.id;
    await c.env.DB.prepare(
      `UPDATE guide_profiles SET stripe_account_id = ?1, updated_at = ?2 WHERE user_id = ?3`
    )
      .bind(acct, new Date().toISOString(), user.id)
      .run();
  }

  const origin = successOrigin(c.env);
  const link = await stripeFetch<{ url: string }>(c.env, '/v1/account_links', {
    body: {
      account: acct,
      type: 'account_onboarding',
      refresh_url: `${origin}/dashboard/billing/?connect=refresh`,
      return_url: `${origin}/dashboard/billing/?connect=return`,
    },
  });

  return c.json({ url: link.url, stripe_account_id: acct });
});

billingRoute.post('/connect/refresh', requireRole('guide'), async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT stripe_account_id FROM guide_profiles WHERE user_id = ?1`
  )
    .bind(user.id)
    .first<{ stripe_account_id: string | null }>();
  if (!row?.stripe_account_id) {
    throw new AppError(409, 'no_connect_account', 'You have not started Connect onboarding yet.');
  }
  const acct = await stripeFetch<{
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
  }>(c.env, `/v1/accounts/${encodeURIComponent(row.stripe_account_id)}`, { method: 'GET' });

  await c.env.DB.prepare(
    `UPDATE guide_profiles SET charges_enabled = ?1, updated_at = ?2 WHERE user_id = ?3`
  )
    .bind(acct.charges_enabled ? 1 : 0, new Date().toISOString(), user.id)
    .run();
  return c.json({
    charges_enabled: acct.charges_enabled,
    payouts_enabled: acct.payouts_enabled,
    details_submitted: acct.details_submitted,
  });
});

// ---------------------------------------------------------------------------
// Stripe Customer Portal (any authenticated user with a customer record).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /v1/billing/subscription — caller's most-recent subscription (or null).
// ---------------------------------------------------------------------------

billingRoute.get('/subscription', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT plan, status, current_period_end, cancel_at_period_end
       FROM subscriptions
      WHERE user_id = ?1
      ORDER BY CASE status
                 WHEN 'active' THEN 0
                 WHEN 'trialing' THEN 1
                 WHEN 'past_due' THEN 2
                 ELSE 3 END,
               updated_at DESC
      LIMIT 1`
  )
    .bind(user.id)
    .first<{
      plan: string;
      status: string;
      current_period_end: string | null;
      cancel_at_period_end: number;
    }>();
  return c.json({
    subscription: row
      ? {
          plan: row.plan,
          status: row.status,
          current_period_end: row.current_period_end,
          cancel_at_period_end: row.cancel_at_period_end === 1,
        }
      : null,
  });
});

billingRoute.post('/portal', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT stripe_customer_id FROM users WHERE id = ?1`
  )
    .bind(user.id)
    .first<{ stripe_customer_id: string | null }>();
  if (!row?.stripe_customer_id) {
    throw new AppError(409, 'no_customer', 'You do not have a billing record yet — make a purchase first.');
  }
  // Travelers manage their subscription from /dashboard/, guides from
  // /dashboard/billing/. Send the user back to wherever they came from when
  // possible; default to /dashboard/.
  let body: { return_to?: unknown } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* empty body is fine */ }
  const returnPath =
    typeof body.return_to === 'string' && body.return_to.startsWith('/')
      ? body.return_to
      : '/dashboard/';
  const session = await stripeFetch<{ url: string }>(c.env, '/v1/billing_portal/sessions', {
    body: {
      customer: row.stripe_customer_id,
      return_url: `${successOrigin(c.env)}${returnPath}`,
    },
  });
  return c.json({ url: session.url });
});
