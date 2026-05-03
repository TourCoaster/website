#!/usr/bin/env node
/**
 * stripe-setup — seed TourCoaster's Stripe Products + Prices in test mode.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
 *
 * Idempotent: looks up existing products by metadata.tourcoaster_plan and
 * reuses them; creates a new monthly price if none matches the configured
 * amount. Prints the resulting price IDs so you can paste them into
 * wrangler.toml ([vars] STRIPE_PRICE_EXPLORER / STRIPE_PRICE_WANDERER).
 */
const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('STRIPE_SECRET_KEY is required (use a sk_test_... key).');
  process.exit(1);
}
if (!SECRET.startsWith('sk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.');
  process.exit(1);
}

const PLANS = [
  { plan: 'explorer', name: 'TourCoaster Explorer', amount: 1900, envVar: 'STRIPE_PRICE_EXPLORER' },
  { plan: 'wanderer', name: 'TourCoaster Wanderer', amount: 3900, envVar: 'STRIPE_PRICE_WANDERER' },
];

const formEncode = (data, prefix = '') => {
  const parts = [];
  const append = (key, val) => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) val.forEach((v, i) => append(`${key}[${i}]`, v));
    else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) append(`${key}[${k}]`, v);
    } else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
  };
  for (const [k, v] of Object.entries(data)) append(prefix ? `${prefix}[${k}]` : k, v);
  return parts.join('&');
};

const stripe = async (path, method = 'GET', body) => {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Stripe-Version': '2024-12-18.acacia',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? formEncode(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} failed: ${json.error?.message || res.status}`);
  }
  return json;
};

const findProduct = async (plan) => {
  // Stripe doesn't filter by metadata server-side without search; list and match.
  let starting_after;
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (starting_after) qs.set('starting_after', starting_after);
    const page = await stripe(`/v1/products?${qs.toString()}`);
    const hit = page.data.find((p) => p.metadata?.tourcoaster_plan === plan);
    if (hit) return hit;
    if (!page.has_more) return null;
    starting_after = page.data.at(-1)?.id;
  }
  return null;
};

const findRecurringPrice = async (productId, amount) => {
  const qs = new URLSearchParams({ product: productId, active: 'true', limit: '100' });
  const page = await stripe(`/v1/prices?${qs.toString()}`);
  return (
    page.data.find(
      (pr) =>
        pr.unit_amount === amount &&
        pr.currency === 'usd' &&
        pr.recurring?.interval === 'month'
    ) ?? null
  );
};

const ensurePlan = async ({ plan, name, amount }) => {
  let product = await findProduct(plan);
  if (!product) {
    product = await stripe('/v1/products', 'POST', {
      name,
      metadata: { tourcoaster_plan: plan },
    });
    console.log(`  + created product ${product.id} (${plan})`);
  } else {
    console.log(`  · reusing product ${product.id} (${plan})`);
  }
  let price = await findRecurringPrice(product.id, amount);
  if (!price) {
    price = await stripe('/v1/prices', 'POST', {
      product: product.id,
      unit_amount: amount,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { tourcoaster_plan: plan },
    });
    console.log(`  + created price ${price.id} ($${(amount / 100).toFixed(2)}/mo)`);
  } else {
    console.log(`  · reusing price ${price.id}`);
  }
  return price.id;
};

console.log('Seeding TourCoaster Stripe products + prices (test mode)…');
const results = {};
for (const p of PLANS) {
  console.log(`\n[${p.plan}]`);
  results[p.envVar] = await ensurePlan(p);
}
console.log('\nDone. Paste these into tourcoaster-api/wrangler.toml [vars]:\n');
for (const [k, v] of Object.entries(results)) console.log(`  ${k} = "${v}"`);
console.log('');
