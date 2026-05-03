import { escapeHtml, escapeJsonLd } from './escape';

const SITE_NAME = 'TourCoaster';
const SITE_ORIGIN = 'https://tourcoaster.com';

type RenderTour = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  location: string | null;
  category: string | null;
  duration_minutes: number | null;
  capacity: number | null;
  price_cents: number;
  currency: string;
  vr_enabled: boolean;
  scheduled_at: string | null;
  published_at: string | null;
  media: Array<{ id: string; r2_key: string; kind: 'image' | 'video' }>;
  guide?: {
    user_id: string;
    slug: string;
    display_name: string | null;
    avatar_key: string | null;
    location: string | null;
  } | null;
};

const formatPrice = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'JPY' ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
};

const formatDuration = (minutes: number | null): string => {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hour${h === 1 ? '' : 's'}` : `${h}h ${m}m`;
};

const mediaUrl = (key: string, apiBase: string): string =>
  `${apiBase}/v1/media/${key.split('/').map(encodeURIComponent).join('/')}`;

const guideAvatarUrl = (
  guide: NonNullable<RenderTour['guide']> | null | undefined,
  apiBase: string
): string =>
  guide?.avatar_key
    ? mediaUrl(guide.avatar_key, apiBase)
    : `${SITE_ORIGIN}/assets/images/avatar.webp`;

export const renderTourPage = (t: RenderTour, apiBase: string): string => {
  const cover =
    t.media.find((m) => m.kind === 'image')?.r2_key ?? null;
  const coverUrl = cover ? mediaUrl(cover, apiBase) : `${SITE_ORIGIN}/assets/images/art/bg1.webp`;
  const title = `${t.title} — ${SITE_NAME}`;
  const description = (t.description ?? `${t.title} on ${SITE_NAME}.`).slice(0, 200);
  const url = `${SITE_ORIGIN}/tours/${encodeURIComponent(t.slug)}`;
  const price = formatPrice(t.price_cents, t.currency);
  const duration = formatDuration(t.duration_minutes);

  const tripLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    name: t.title,
    description: t.description ?? undefined,
    url,
    image: coverUrl,
    touristType: t.category ?? undefined,
    offers: {
      '@type': 'Offer',
      price: (t.price_cents / 100).toFixed(2),
      priceCurrency: t.currency,
      url,
      availability: 'https://schema.org/InStock',
    },
  };
  if (t.location) {
    tripLd.itinerary = {
      '@type': 'Place',
      name: t.location,
      address: { '@type': 'PostalAddress', addressLocality: t.location },
    };
  }
  if (t.guide?.display_name) {
    tripLd.provider = {
      '@type': 'Person',
      name: t.guide.display_name,
      url: `${SITE_ORIGIN}/guides/${t.guide.slug}`,
    };
  }

  const ldBlocks: string[] = [
    `<script type="application/ld+json">${escapeJsonLd(tripLd)}</script>`,
  ];

  if (t.vr_enabled && t.scheduled_at) {
    const eventLd = {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: `${t.title} (VR)`,
      startDate: t.scheduled_at,
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      eventStatus: 'https://schema.org/EventScheduled',
      location: {
        '@type': 'VirtualLocation',
        url,
      },
      offers: {
        '@type': 'Offer',
        url,
        price: (t.price_cents / 100).toFixed(2),
        priceCurrency: t.currency,
        availability: 'https://schema.org/InStock',
      },
      description: t.description ?? undefined,
    };
    ldBlocks.push(`<script type="application/ld+json">${escapeJsonLd(eventLd)}</script>`);
  }

  const galleryHtml =
    t.media.length > 1
      ? `<div class="row gy-2 mt-4">${t.media
          .slice(0, 6)
          .map(
            (m) =>
              `<div class="col-4 col-md-3"><img src="${escapeHtml(
                mediaUrl(m.r2_key, apiBase)
              )}" alt="" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;"></div>`
          )
          .join('')}</div>`
      : '';

  const guideBlock = t.guide
    ? `<div class="d-flex align-items-center gap-3 mt-4">
         <img src="${escapeHtml(guideAvatarUrl(t.guide, apiBase))}" alt=""
              style="width:56px;height:56px;border-radius:50%;object-fit:cover;">
         <div>
           <small class="text-muted">Hosted by</small><br>
           <a href="${SITE_ORIGIN}/guides/${escapeHtml(t.guide.slug)}" class="fw-semibold">
             ${escapeHtml(t.guide.display_name ?? t.guide.slug)}</a>
           ${t.guide.location ? `<span class="text-muted"> · ${escapeHtml(t.guide.location)}</span>` : ''}
         </div>
       </div>`
    : '';

  const vrBlock =
    t.vr_enabled && t.scheduled_at
      ? `<div class="alert alert-info mt-3"><strong>VR session:</strong>
         <time datetime="${escapeHtml(t.scheduled_at)}">${escapeHtml(t.scheduled_at)}</time></div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(url)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(coverUrl)}">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(coverUrl)}">
  <link rel="stylesheet" href="${SITE_ORIGIN}/assets/css/plugins.css">
  <link rel="stylesheet" href="${SITE_ORIGIN}/assets/css/style.css">
  <link rel="stylesheet" href="${SITE_ORIGIN}/assets/css/color/green.css">
  ${ldBlocks.join('\n  ')}
  <script src="${SITE_ORIGIN}/assets/js/billing.js" defer></script>
</head>
<body>
  <main class="wrapper white-wrapper">
    <div class="container inner" style="max-width:980px;">
      <a href="${SITE_ORIGIN}/explore" class="text-muted small">&larr; All tours</a>
      <figure class="mt-3" style="margin:0;">
        <img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(t.title)}"
             style="width:100%;max-height:520px;object-fit:cover;border-radius:12px;">
      </figure>
      <div class="row gy-4 mt-2">
        <div class="col-lg-8">
          <h1 class="mb-2">${escapeHtml(t.title)}</h1>
          <p class="text-muted mb-3">
            ${t.location ? `<i class="jam jam-map-marker me-1"></i>${escapeHtml(t.location)}` : ''}
            ${duration ? ` &middot; <i class="jam jam-clock me-1"></i>${escapeHtml(duration)}` : ''}
            ${t.category ? ` &middot; <span class="badge bg-light text-dark">${escapeHtml(t.category)}</span>` : ''}
            ${t.vr_enabled ? ' &middot; <span class="badge bg-primary">VR</span>' : ''}
          </p>
          <h2 class="h5 mt-4">About this tour</h2>
          ${t.description ? `<p style="white-space:pre-wrap;">${escapeHtml(t.description)}</p>` : '<p class="text-muted">No description provided.</p>'}
          ${galleryHtml}
          ${guideBlock}
        </div>
        <aside class="col-lg-4">
          <div class="card shadow-sm rounded-4 p-4">
            <div class="h4 mb-1">${escapeHtml(price)}</div>
            <div class="text-muted small mb-3">per person</div>
            ${t.capacity ? `<p class="small mb-2"><i class="jam jam-user me-1"></i>Up to ${t.capacity} guests</p>` : ''}
            ${vrBlock}
            <button type="button" class="btn btn-primary w-100 rounded-pill mt-2"
                    data-book-tour="${escapeHtml(t.id)}">Book this tour</button>
            <p class="small text-muted mt-2 mb-0">Secure checkout via Stripe.</p>
          </div>
        </aside>
      </div>
    </div>
  </main>
</body>
</html>`;
};
