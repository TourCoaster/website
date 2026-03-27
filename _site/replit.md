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
- `index.html` — Homepage (hero, featured tours, VR section, guides, accessibility)
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

Configured as the "Start application" workflow on port 5000.

## Deployment

Static site deployment:
- **Build command:** `bundle exec jekyll build`
- **Public directory:** `_site`

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
