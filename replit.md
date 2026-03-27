# Snowlake Jekyll Website

## Overview

Snowlake is a multi-purpose static website template built with Jekyll. It includes pre-built layouts for portfolios, blogs, shops, and business pages.

## Tech Stack

- **Static Site Generator:** Jekyll (~> 4.3.2)
- **Language:** Ruby (3.2), HTML/Liquid templates
- **Frontend:** Bootstrap, jQuery
- **Plugins:** jekyll-feed, jekyll-paginate-v2, jekyll-archives
- **Package Manager:** Bundler

## Project Structure

- `_config.yml` — Jekyll configuration (site settings, plugins, pagination, collections)
- `Gemfile` / `Gemfile.lock` — Ruby gem dependencies
- `_layouts/` — Page layout templates
- `_includes/` — Reusable HTML snippets
- `_posts/` — Blog posts in Markdown
- `_portfolio/` — Portfolio collection items
- `_shop_items/` — Shop product collection
- `_authors/` — Author profiles collection
- `_data/` — Global YAML data files (navigation, settings, etc.)
- `assets/` — Static assets (CSS, JS, images)
- `_site/` — Build output (generated, not committed)

## Running Locally

The site is served via Jekyll's built-in server:

```
bundle exec jekyll serve --host 0.0.0.0 --port 5000 --livereload
```

This is configured as the "Start application" workflow and runs on port 5000.

## Deployment

Configured as a static site deployment:
- **Build command:** `bundle exec jekyll build`
- **Public directory:** `_site`
