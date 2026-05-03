# TourCoaster - Global Tour Guide Network

## Overview

TourCoaster is a hybrid exploration network built on the Snowlake Jekyll theme. It connects travelers with verified local guides for authentic hiking and city tours worldwide, with integrated VR experiences for accessibility and remote exploration.

## Tech Stack

- **Static Site Generator:** Jekyll (~> 4.3.2)
- **Language:** Ruby (3.2), HTML/Liquid templates
- **Frontend:** Bootstrap, jQuery, Jam Icons
- **Plugins:** jekyll-feed, jekyll-paginate-v2, jekyll-archives
- **Package Manager:** Bundler
- **Color Scheme:** Green (configurable per-page)

## Project Structure

### Core Config
- `_config.yml` — Jekyll configuration (collections, plugins, pagination, defaults)
- `Gemfile` / `Gemfile.lock` — Ruby gem dependencies

### Collections (TourCoaster)
- `_guides/` — Guide profile pages (layout: guide-profile)
- `_tours/` — Tour detail pages (layout: tour-detail)
- `_vr_experiences/` — VR experience pages (layout: vr-detail)

### Data Files
- `_data/guides.yml` — Guide profiles data
- `_data/tours.yml` — Tour listings data
- `_data/vr_experiences.yml` — VR experience data
- `_data/navigation.yml` — Main menu structure
- `_data/general_settings.yml` — Site-wide settings (branding, footer, social)

### Layouts
- `_layouts/default.html` — Base HTML template
- `_layouts/guide-profile.html` — Guide profile with tours and VR sections
- `_layouts/tour-detail.html` — Tour detail with booking sidebar
- `_layouts/vr-detail.html` — VR experience detail with compatibility info

### Includes (Custom)
- `_includes/tour-card.html` — Reusable tour card component
- `_includes/guide-card.html` — Reusable guide card component
- `_includes/vr-card.html` — Reusable VR experience card component

### Pages
- `index.html` — Platform landing page (hero with badge + dual CTAs, trust bar, How It Works, featured tours, two-sides marketplace split for travelers/guides, VR section, guides, testimonials, accessibility, stats, final CTA)
- `explore.html` — Tour search with client-side filtering
- `vr-experiences.html` — VR experiences landing page
- `guides.html` — All guides directory
- `destinations.html` — Tours organized by continent
- `for-guides.html` — Guide recruitment page
- `about.html` — About TourCoaster
- `accessibility.html` — Accessibility features page

### Legacy (Snowlake Theme)
- `_portfolio/` — Portfolio collection (retained for theme compatibility)
- `_shop_items/` — Shop product collection
- `_posts/` — Blog posts
- `_authors/` — Author profiles
- `_includes/layouts/` — Nav, header, footer variants
- `assets/` — CSS, JS, images, fonts

## Running Locally

```
bundle exec jekyll serve --host 0.0.0.0 --port 5000
```

Configured as the "Start application" workflow on port 5000. The
`_plugins/prefetch_discovery.rb` Jekyll hook runs
`scripts/prefetch-discovery.mjs` automatically on each build so
`_data/discovery.yml` is refreshed from `/v1/sitemap-data`. Set
`PREFETCH_DISCOVERY=0` to skip and `DISCOVERY_API_URL` to point at a
non-default API host. The script preserves the previous snapshot if
the API is unreachable.

## Deployment

Static site deployment:
- **Build command:** `node scripts/prefetch-discovery.mjs && bundle exec jekyll build`
- **Public directory:** `_site`
- Configured in `netlify.toml` and `cloudflare.toml`. `npm run build`
  is the canonical local command.

## URL Structure
- `/` — Homepage
- `/explore` — Browse all tours
- `/vr-experiences` — VR experiences
- `/guides` — All guides
- `/guides/:name/` — Individual guide profile
- `/tours/:name/` — Individual tour detail
- `/vr/:name/` — Individual VR experience
- `/destinations` — Tours by continent
- `/for-guides` — Guide application
- `/about` — About page
- `/accessibility` — Accessibility features
- `/blogs/index` — Blog listing
- `/browse/` — Static crawler-friendly snapshot of every published tour + guide
- `/sitemap.xml` — Augmented with prefetched API data (see below)
- `/robots.txt` — Allow-all with sitemap reference (account-only paths
  are protected by Cloudflare Access, not robots.txt)

## SEO & Discovery (Phase 11)

- API: `GET /v1/search?q=` (LIKE search across guide names, tour
  titles/descriptions, locations) and `GET /v1/sitemap-data` (cached 5 min).
- Build-time prefetch: `node scripts/prefetch-discovery.mjs` writes
  `_data/discovery.yml`. Run before `bundle exec jekyll build`. Falls back
  to the existing snapshot (or an empty stub) if the API is unreachable.
- `sitemap.xml` and `browse.html` consume `site.data.discovery` so live
  tours/guides are crawlable even though they live in D1, not Jekyll.
- JSON-LD: `_includes/seo.html` emits Organization + WebSite on home,
  `TouristTrip` (and `Event` for live VR) on tour pages, `Person` on
  guide pages, `BlogPosting` on blog posts. Driven by `page.jsonld_kind`.
- OG/Twitter cards via `_includes/core/head/meta-og-tags.html` (absolute
  URLs, fallback chain, configurable `og_type` / `og_image`).
- Dynamic OG images: `og.tourcoaster.com/{tour,guide,site}.png` served
  by the same Workers binary, rasterized to real PNGs via `workers-og`
  (satori + resvg/yoga wasm). Matching `.svg` variants are also served.
  Tour and guide layouts default `og:image` / `twitter:image` to these
  URLs whenever `page.slug` is present.
  - Architecture note: there is one Worker binary. Cloudflare routes
    bind both `api.tourcoaster.com/*` and `og.tourcoaster.com/*` to it.
    `index.ts` host-dispatches: requests whose `Host` starts with `og.`
    go to the OG router; everything else hits the API. DNS: a proxied
    CNAME `og` -> the Workers route is required.
- IndexNow: daily Cloudflare Cron (`17 4 * * *`) at
  `tourcoaster-api/src/scheduled.ts` diffs the sitemap snapshot stored in
  the FLAGS KV and POSTs changed URLs to api.indexnow.org. Set the
  `INDEXNOW_KEY` Worker secret to enable; the Worker also serves
  `/<key>.txt` for ownership verification.
