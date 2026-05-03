import { Hono } from 'hono';
import type { AppEnv, Plan } from '../types';
import { AppError } from '../middleware/error';
import { verifyStripeSignature, type StripeEvent } from '../stripe/api';

export const webhooksRoute = new Hono<AppEnv>();

/**
 * Stripe webhook entry point.
 *
 * Body is consumed as raw text (signature is over the exact bytes).
 * Each event id is recorded in `webhook_events` via INSERT OR IGNORE; a
 * duplicate insert (changes === 0) means we've already processed this event
 * and we exit 200 without re-running side effects.
 *
 * The handler always responds 200 once the signature is valid, even if the
 * specific event type is unknown — Stripe expects 2xx for "received".
 */
webhooksRoute.post('/stripe', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, 'stripe_not_configured', 'Stripe webhooks are not configured.');
  }
  const raw = await c.req.text();
  const sig = c.req.header('Stripe-Signature');
  const event = await verifyStripeSignature(raw, sig, c.env.STRIPE_WEBHOOK_SECRET);

  // Idempotency: we record the event id BEFORE side effects. If the row
  // already exists (changes === 0) we early-return.
  const insert = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events (id, type, livemode) VALUES (?1, ?2, ?3)`
  )
    .bind(event.id, event.type, event.livemode ? 1 : 0)
    .run();
  if (insert.meta.changes === 0) {
    return c.json({ ok: true, deduped: true });
  }

  try {
    await dispatch(c.env, event);
  } catch (err) {
    // Roll back the idempotency record so Stripe will retry. We still want to
    // surface the error so it shows up in logs/alerts.
    await c.env.DB.prepare(`DELETE FROM webhook_events WHERE id = ?1`).bind(event.id).run();
    throw err;
  }
  return c.json({ ok: true });
});

const dispatch = async (env: AppEnv['Bindings'], event: StripeEvent): Promise<void> => {
  switch (event.type) {
    case 'checkout.session.completed':
      await onCheckoutCompleted(env, event);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await onSubscriptionUpdated(env, event);
      return;
    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(env, event);
      return;
    case 'payment_intent.payment_failed':
      await onPaymentFailed(env, event);
      return;
    case 'account.updated':
      await onAccountUpdated(env, event);
      return;
    default:
      // Unhandled types are intentionally a no-op (still 200-ack).
      return;
  }
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type CheckoutSession = {
  id: string;
  mode: 'payment' | 'subscription' | 'setup';
  customer?: string | null;
  client_reference_id?: string | null;
  payment_intent?: string | null;
  payment_status?: 'paid' | 'unpaid' | 'no_payment_required' | null;
  amount_total?: number | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
};

const onCheckoutCompleted = async (env: AppEnv['Bindings'], event: StripeEvent): Promise<void> => {
  const session = event.data.object as unknown as CheckoutSession;
  const meta = session.metadata ?? {};

  if (meta.tourcoaster_kind === 'in_person') {
    const bookingId = meta.tourcoaster_booking_id ?? session.client_reference_id;
    const tourId = meta.tourcoaster_tour_id;
    const travelerId = meta.tourcoaster_traveler_id;
    if (!bookingId || !tourId || !travelerId) return;

    const amount = Number(meta.tourcoaster_amount_cents ?? session.amount_total ?? 0);
    const currency = (meta.tourcoaster_currency ?? session.currency ?? 'USD').toUpperCase();
    const fee = Number(meta.tourcoaster_platform_fee_cents ?? 0);
    const scheduled = meta.tourcoaster_scheduled_at ?? null;
    // Only treat the booking as paid if Stripe says funds are confirmed.
    // Async methods would arrive as 'unpaid' here and resolve later via
    // payment_intent.succeeded / .payment_failed.
    const status = session.payment_status === 'paid' ? 'paid' : 'pending';

    await env.DB.prepare(
      `INSERT INTO bookings
         (id, tour_id, traveler_id, scheduled_at, amount_cents, currency,
          platform_fee_cents, stripe_checkout_session_id, stripe_payment_intent_id, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         stripe_payment_intent_id = excluded.stripe_payment_intent_id,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
      .bind(
        bookingId,
        tourId,
        travelerId,
        scheduled,
        amount,
        currency,
        fee,
        session.id,
        session.payment_intent ?? null,
        status
      )
      .run();
    return;
  }

  // Subscription mode: Stripe also fires customer.subscription.created which
  // is where we persist the full subscription row. Here we only ensure the
  // user's stripe_customer_id is linked.
  if (session.mode === 'subscription' && session.customer && meta.tourcoaster_user_id) {
    await env.DB.prepare(
      `UPDATE users SET stripe_customer_id = ?1, updated_at = ?2 WHERE id = ?3 AND stripe_customer_id IS NULL`
    )
      .bind(session.customer, new Date().toISOString(), meta.tourcoaster_user_id)
      .run();
  }
};

type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
  items: { data: Array<{ price: { id: string } }> };
  metadata?: Record<string, string> | null;
};

const inferPlan = (env: AppEnv['Bindings'], priceId: string): Plan | null => {
  if (env.STRIPE_PRICE_EXPLORER && priceId === env.STRIPE_PRICE_EXPLORER) return 'explorer';
  if (env.STRIPE_PRICE_WANDERER && priceId === env.STRIPE_PRICE_WANDERER) return 'wanderer';
  return null;
};

const onSubscriptionUpdated = async (
  env: AppEnv['Bindings'],
  event: StripeEvent
): Promise<void> => {
  const sub = event.data.object as unknown as StripeSubscription;
  const meta = sub.metadata ?? {};

  // Resolve the tourcoaster user. Prefer metadata; fall back to customer id.
  let userId = meta.tourcoaster_user_id ?? null;
  if (!userId) {
    const row = await env.DB.prepare(
      `SELECT id FROM users WHERE stripe_customer_id = ?1 LIMIT 1`
    )
      .bind(sub.customer)
      .first<{ id: string }>();
    userId = row?.id ?? null;
  }
  if (!userId) return;

  const priceId = sub.items?.data?.[0]?.price?.id ?? '';
  const plan: Plan = (meta.tourcoaster_plan as Plan) ?? inferPlan(env, priceId) ?? 'explorer';
  const status = ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete'].includes(
    sub.status
  )
    ? sub.status
    : 'incomplete';
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, user_id, stripe_customer_id, stripe_subscription_id, plan, status,
        current_period_end, cancel_at_period_end)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(stripe_subscription_id) DO UPDATE SET
       status = excluded.status,
       plan = excluded.plan,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  )
    .bind(
      crypto.randomUUID(),
      userId,
      sub.customer,
      sub.id,
      plan,
      status,
      periodEnd,
      sub.cancel_at_period_end ? 1 : 0
    )
    .run();

  // Make sure customer link is recorded.
  await env.DB.prepare(
    `UPDATE users SET stripe_customer_id = ?1, updated_at = ?2
       WHERE id = ?3 AND (stripe_customer_id IS NULL OR stripe_customer_id != ?1)`
  )
    .bind(sub.customer, new Date().toISOString(), userId)
    .run();
};

const onSubscriptionDeleted = async (
  env: AppEnv['Bindings'],
  event: StripeEvent
): Promise<void> => {
  const sub = event.data.object as unknown as StripeSubscription;
  await env.DB.prepare(
    `UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE stripe_subscription_id = ?1`
  )
    .bind(sub.id)
    .run();
};

type PaymentIntent = {
  id: string;
  metadata?: Record<string, string> | null;
};

const onPaymentFailed = async (env: AppEnv['Bindings'], event: StripeEvent): Promise<void> => {
  const pi = event.data.object as unknown as PaymentIntent;
  const bookingId = pi.metadata?.tourcoaster_booking_id;
  if (bookingId) {
    await env.DB.prepare(
      `UPDATE bookings SET status = 'failed',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND status = 'pending'`
    )
      .bind(bookingId)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE bookings SET status = 'failed',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE stripe_payment_intent_id = ?1 AND status IN ('pending','paid')`
  )
    .bind(pi.id)
    .run();
};

type ConnectAccount = {
  id: string;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
};

const onAccountUpdated = async (env: AppEnv['Bindings'], event: StripeEvent): Promise<void> => {
  const acct = event.data.object as unknown as ConnectAccount;
  await env.DB.prepare(
    `UPDATE guide_profiles SET charges_enabled = ?1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE stripe_account_id = ?2`
  )
    .bind(acct.charges_enabled ? 1 : 0, acct.id)
    .run();
};
