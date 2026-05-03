import { Hono } from 'hono';
import type { AppEnv, Plan } from '../types';
import { AppError } from '../middleware/error';
import { requireAccessAuth } from '../auth/middleware';
import { stripeFetch } from '../stripe/api';

export const checkoutRoute = new Hono<AppEnv>();
checkoutRoute.use('*', requireAccessAuth());

const platformFeeBps = (env: AppEnv['Bindings']): number => {
  const raw = env.PLATFORM_FEE_BPS;
  const n = raw ? parseInt(raw, 10) : 1500;
  if (!Number.isFinite(n) || n < 0 || n > 5000) return 1500;
  return n;
};

const computeFeeCents = (amountCents: number, bps: number): number =>
  Math.max(0, Math.floor((amountCents * bps) / 10000));

const successOrigin = (env: AppEnv['Bindings']): string =>
  env.PUBLIC_SITE_ORIGIN || 'https://tourcoaster.com';

/**
 * Look up (or lazily create) the Stripe Customer for a TourCoaster user.
 * Persists `stripe_customer_id` on `users` so subsequent purchases reuse it
 * and the customer portal works.
 */
const ensureCustomer = async (
  env: AppEnv['Bindings'],
  user: { id: string; email: string }
): Promise<string> => {
  const existing = await env.DB.prepare(`SELECT stripe_customer_id FROM users WHERE id = ?1`)
    .bind(user.id)
    .first<{ stripe_customer_id: string | null }>();
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const created = await stripeFetch<{ id: string }>(env, '/v1/customers', {
    body: { email: user.email, metadata: { tourcoaster_user_id: user.id } },
    idempotencyKey: `customer_create_${user.id}`,
  });
  await env.DB.prepare(
    `UPDATE users SET stripe_customer_id = ?1, updated_at = ?2 WHERE id = ?3`
  )
    .bind(created.id, new Date().toISOString(), user.id)
    .run();
  return created.id;
};

// ---------------------------------------------------------------------------
// POST /v1/checkout/in-person — destination charge for a tour booking.
// Body: { tour_id: string, scheduled_at?: string }
// Returns: { url, sessionId }
// ---------------------------------------------------------------------------

checkoutRoute.post('/in-person', async (c) => {
  const user = c.get('user');
  let body: { tour_id?: unknown; slug?: unknown; scheduled_at?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }
  const tourId = typeof body.tour_id === 'string' ? body.tour_id : '';
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!tourId && !slug) {
    throw new AppError(422, 'missing_tour_ref', 'tour_id or slug is required.');
  }
  const scheduledAt =
    typeof body.scheduled_at === 'string' && !Number.isNaN(Date.parse(body.scheduled_at))
      ? body.scheduled_at
      : null;

  // Resolve tour by id (UUID) or slug. Slugs are public/stable; ids are used
  // by the worker-rendered pages where we already know the row id.
  const tour = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.description, t.owner_id, t.price_cents, t.currency, t.status,
            g.stripe_account_id, g.charges_enabled
       FROM tours t
       JOIN guide_profiles g ON g.user_id = t.owner_id
      WHERE (?1 != '' AND t.id = ?1) OR (?2 != '' AND t.slug = ?2)
      LIMIT 1`
  )
    .bind(tourId, slug)
    .first<{
      id: string;
      title: string;
      description: string | null;
      owner_id: string;
      price_cents: number;
      currency: string;
      status: string;
      stripe_account_id: string | null;
      charges_enabled: number;
    }>();
  if (!tour || tour.status !== 'published') {
    throw new AppError(404, 'tour_not_found', 'Tour not found.');
  }
  if (tour.owner_id === user.id) {
    throw new AppError(409, 'self_booking', 'You cannot book your own tour.');
  }
  if (!tour.stripe_account_id || tour.charges_enabled !== 1) {
    throw new AppError(409, 'guide_not_payable', 'This guide has not finished payout setup yet.');
  }
  if (tour.price_cents <= 0) {
    throw new AppError(409, 'tour_not_priced', 'This tour cannot be booked online (no price set).');
  }

  const customerId = await ensureCustomer(c.env, user);
  const fee = computeFeeCents(tour.price_cents, platformFeeBps(c.env));
  const origin = successOrigin(c.env);
  const bookingId = crypto.randomUUID();

  const session = await stripeFetch<{ id: string; url: string }>(c.env, '/v1/checkout/sessions', {
    body: {
      mode: 'payment',
      customer: customerId,
      client_reference_id: bookingId,
      success_url: `${origin}/checkout/success/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout/cancel/?tour=${encodeURIComponent(tour.id)}`,
      payment_intent_data: {
        application_fee_amount: fee,
        transfer_data: { destination: tour.stripe_account_id },
        metadata: {
          tourcoaster_kind: 'in_person',
          tourcoaster_booking_id: bookingId,
          tourcoaster_tour_id: tour.id,
          tourcoaster_traveler_id: user.id,
          tourcoaster_guide_id: tour.owner_id,
        },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: tour.currency.toLowerCase(),
            unit_amount: tour.price_cents,
            product_data: {
              name: tour.title,
              ...(tour.description ? { description: tour.description.slice(0, 500) } : {}),
            },
          },
        },
      ],
      metadata: {
        tourcoaster_kind: 'in_person',
        tourcoaster_booking_id: bookingId,
        tourcoaster_tour_id: tour.id,
        tourcoaster_traveler_id: user.id,
        tourcoaster_guide_id: tour.owner_id,
        tourcoaster_amount_cents: String(tour.price_cents),
        tourcoaster_currency: tour.currency,
        tourcoaster_platform_fee_cents: String(fee),
        ...(scheduledAt ? { tourcoaster_scheduled_at: scheduledAt } : {}),
      },
    },
    idempotencyKey: `checkout_inperson_${bookingId}`,
  });

  return c.json({ url: session.url, sessionId: session.id, bookingId });
});

// ---------------------------------------------------------------------------
// POST /v1/checkout/subscription — recurring VR access.
// Body: { plan: 'explorer' | 'wanderer' }
// ---------------------------------------------------------------------------

const planToPriceEnv: Record<Plan, keyof AppEnv['Bindings']> = {
  explorer: 'STRIPE_PRICE_EXPLORER',
  wanderer: 'STRIPE_PRICE_WANDERER',
};

checkoutRoute.post('/subscription', async (c) => {
  const user = c.get('user');
  let body: { plan?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw new AppError(400, 'invalid_body', 'Body must be JSON.');
  }
  const plan = body.plan;
  if (plan !== 'explorer' && plan !== 'wanderer') {
    throw new AppError(422, 'invalid_plan', 'plan must be "explorer" or "wanderer".');
  }
  const price = c.env[planToPriceEnv[plan]] as string | undefined;
  if (!price) {
    throw new AppError(503, 'plan_not_configured', `Pricing for ${plan} is not configured.`);
  }

  const customerId = await ensureCustomer(c.env, user);
  const origin = successOrigin(c.env);

  const session = await stripeFetch<{ id: string; url: string }>(c.env, '/v1/checkout/sessions', {
    body: {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      success_url: `${origin}/checkout/success/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout/cancel/?plan=${plan}`,
      line_items: [{ price, quantity: 1 }],
      subscription_data: {
        metadata: {
          tourcoaster_kind: 'subscription',
          tourcoaster_user_id: user.id,
          tourcoaster_plan: plan,
        },
      },
      metadata: {
        tourcoaster_kind: 'subscription',
        tourcoaster_user_id: user.id,
        tourcoaster_plan: plan,
      },
    },
    idempotencyKey: `checkout_sub_${user.id}_${plan}`,
  });

  return c.json({ url: session.url, sessionId: session.id });
});
