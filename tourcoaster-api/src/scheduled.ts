import type { AppEnv } from './types';
import { buildSitemapPayload } from './routes/discovery';

// ----------------------------------------------------------------------------
// Cloudflare Cron Trigger handler. Runs daily, diffs the current published
// guides + tours against the previous snapshot stored in the FLAGS KV, and
// submits changed/new URLs to IndexNow. Bing/Yandex/Naver/Seznam all consume
// IndexNow; Google still uses sitemap discovery, so we also re-submit the
// sitemap URL to ensure freshness.
// ----------------------------------------------------------------------------

const KV_KEY = 'discovery:sitemap-snapshot:v1';

type Snapshot = Record<string, string>; // url -> updated_at iso

const buildSnapshot = (
  origin: string,
  payload: Awaited<ReturnType<typeof buildSitemapPayload>>
): Snapshot => {
  const out: Snapshot = {};
  for (const t of payload.tours) out[`${origin}/tours/${t.slug}/`] = t.updated_at;
  for (const g of payload.guides) out[`${origin}/guides/${g.slug}/`] = g.updated_at;
  return out;
};

const diffUrls = (prev: Snapshot, next: Snapshot): string[] => {
  const changed: string[] = [];
  for (const [url, ts] of Object.entries(next)) {
    if (prev[url] !== ts) changed.push(url);
  }
  return changed;
};

const submitIndexNow = async (
  env: AppEnv['Bindings'],
  host: string,
  urls: string[]
): Promise<boolean> => {
  const key = env.INDEXNOW_KEY;
  if (!key) return false;
  if (urls.length === 0) return true;
  const body = {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList: urls.slice(0, 10000),
  };
  const res = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('indexnow_failed', res.status, text.slice(0, 200));
    return false;
  }
  return true;
};

export const scheduled = async (
  _event: ScheduledEvent,
  env: AppEnv['Bindings'],
  ctx: ExecutionContext
): Promise<void> => {
  const origin = (env.PUBLIC_SITE_ORIGIN || 'https://tourcoaster.com').replace(/\/$/, '');
  const host = new URL(origin).host;

  const payload = await buildSitemapPayload(env);
  const next = buildSnapshot(origin, payload);

  let prev: Snapshot = {};
  try {
    const raw = await env.FLAGS.get(KV_KEY);
    if (raw) prev = JSON.parse(raw) as Snapshot;
  } catch (err) {
    console.error('snapshot_read_failed', err);
  }

  const changed = diffUrls(prev, next);
  const urls = Array.from(new Set([`${origin}/sitemap.xml`, ...changed]));

  ctx.waitUntil(
    (async () => {
      const ok = await submitIndexNow(env, host, urls);
      // Only persist the snapshot when the IndexNow ping actually succeeded
      // (or when no key is configured and there's nothing to retry). On
      // failure we keep the previous snapshot so the next cron run will
      // re-submit the same URLs.
      if (ok) {
        try {
          await env.FLAGS.put(KV_KEY, JSON.stringify(next));
        } catch (err) {
          console.error('snapshot_write_failed', err);
        }
      }
    })()
  );
};
