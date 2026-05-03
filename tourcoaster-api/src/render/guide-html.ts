import type { GuideProfile } from '../types';
import { escapeHtml, escapeJsonLd } from './escape';

const SITE_NAME = 'TourCoaster';
const SITE_ORIGIN = 'https://tourcoaster.com';

const avatarUrl = (g: GuideProfile, apiBase: string): string =>
  g.avatar_key
    ? `${apiBase}/v1/media/${encodeURI(g.avatar_key)}`
    : `${SITE_ORIGIN}/assets/images/avatar.webp`;

export const renderGuidePage = (g: GuideProfile, apiBase: string): string => {
  const title = `${g.display_name ?? g.slug} — Guide on ${SITE_NAME}`;
  const description = g.bio
    ? g.bio.slice(0, 160)
    : `${g.display_name ?? g.slug} is a verified guide on ${SITE_NAME}.`;
  const url = `${SITE_ORIGIN}/guides/${encodeURIComponent(g.slug)}`;
  const avatar = avatarUrl(g, apiBase);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: g.display_name ?? g.slug,
    url,
    image: avatar,
    description: g.bio ?? undefined,
    address: g.location
      ? { '@type': 'PostalAddress', addressLocality: g.location }
      : undefined,
    knowsLanguage: g.languages.length > 0 ? g.languages : undefined,
  };

  const langPills = g.languages
    .map((l) => `<span class="badge bg-light text-dark me-2 mb-2">${escapeHtml(l)}</span>`)
    .join('');

  const bioHtml = g.bio
    ? g.bio
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('')
    : '<p class="text-muted">This guide hasn\'t added a bio yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(url)}">
  <meta property="og:type" content="profile">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="https://og.tourcoaster.com/guide/${encodeURIComponent(g.slug)}.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="https://og.tourcoaster.com/guide/${encodeURIComponent(g.slug)}.png">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="me" href="${escapeHtml(avatar)}">
  <link rel="image_src" href="${escapeHtml(avatar)}">
  <link rel="stylesheet" href="${SITE_ORIGIN}/assets/css/plugins.css">
  <link rel="stylesheet" href="${SITE_ORIGIN}/assets/css/style.css">
  <link rel="stylesheet" href="${SITE_ORIGIN}/assets/css/color/green.css">
  <script type="application/ld+json">${escapeJsonLd(jsonLd)}</script>
</head>
<body>
  <main class="wrapper white-wrapper">
    <div class="container inner" style="max-width:880px;">
      <a href="${SITE_ORIGIN}/guides" class="text-muted small">&larr; All guides</a>
      <div class="row gy-4 align-items-center mt-3">
        <div class="col-md-4 text-center">
          <img src="${escapeHtml(avatar)}" alt="${escapeHtml(g.display_name ?? g.slug)}"
               class="rounded-circle shadow-sm" width="220" height="220"
               style="object-fit:cover;width:220px;height:220px;">
        </div>
        <div class="col-md-8">
          <h1 class="mb-2">${escapeHtml(g.display_name ?? g.slug)}</h1>
          ${g.location ? `<p class="text-muted mb-3"><i class="jam jam-map-marker me-1"></i>${escapeHtml(g.location)}</p>` : ''}
          ${langPills ? `<div class="mb-3">${langPills}</div>` : ''}
        </div>
      </div>
      <hr class="my-5">
      <section>
        <h2 class="h4 mb-3">About</h2>
        ${bioHtml}
      </section>
      <hr class="my-5">
      <section>
        <h2 class="h4 mb-3">Tours</h2>
        <p class="text-muted">Tours by ${escapeHtml(g.display_name ?? g.slug)} will appear here as they are published.</p>
      </section>
    </div>
  </main>
</body>
</html>`;
};
