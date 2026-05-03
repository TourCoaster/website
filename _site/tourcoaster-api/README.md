# tourcoaster-api

Cloudflare Workers API for [TourCoaster](../). TypeScript + [Hono](https://hono.dev/) with D1, KV, and R2.

## Stack

| Concern | Tech |
|---|---|
| Runtime | Cloudflare Workers (V8 isolates) |
| Framework | Hono v4 |
| Language | TypeScript (strict, no-emit; bundled by Wrangler) |
| Database | Cloudflare D1 (SQLite at the edge) |
| KV | `SESSIONS`, `FLAGS` |
| Object storage | Cloudflare R2 (`tourcoaster-media`) |
| Tooling | Wrangler v3 |

## Quick start

```bash
# 1. Install deps
npm install

# 2. Provision Cloudflare resources (one-time, in your Cloudflare account)
npx wrangler d1 create tourcoaster
npx wrangler kv:namespace create SESSIONS
npx wrangler kv:namespace create SESSIONS --preview
npx wrangler kv:namespace create FLAGS
npx wrangler kv:namespace create FLAGS --preview
npx wrangler r2 bucket create tourcoaster-media
npx wrangler r2 bucket create tourcoaster-media-preview

# Copy the IDs printed by each command into wrangler.toml
# (replace every REPLACE_WITH_… placeholder).

# 3. Local secrets
cp .dev.vars.example .dev.vars
# fill in real values

# 4. Apply schema locally
npm run db:migrate:local

# 5. Run
npm run dev
# → http://localhost:8787
curl http://localhost:8787/v1/health
# → { "ok": true, "time": "...", "environment": "development", "requestId": "..." }
```

## Deploy

```bash
# 6. Apply schema to remote D1
npm run db:migrate:remote

# 7. Set production secrets (one per command)
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STREAM_API_TOKEN
# …etc; see .dev.vars.example for the full list.

# 8. Deploy
npm run deploy
```

DNS: add a `routes` block to `wrangler.toml` once `tourcoaster.com` is on
Cloudflare and you've decided on the hostname (e.g. `api.tourcoaster.com`).

## Layout

```
src/
  index.ts                  # Hono app entry, route mounting
  types.ts                  # Bindings + Variables type
  middleware/
    cors.ts                 # CORS allow-list
    error.ts                # JSON error handler + 404 + AppError
    request-id.ts           # X-Request-Id propagation
  routes/
    health.ts               # GET /v1/health
migrations/
  0001_init.sql             # initial schema
wrangler.toml               # bindings + vars
.dev.vars.example           # local-only secret template
```

## Bindings

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 | All persistent business data. Schema in `migrations/`. |
| `SESSIONS` | KV | Hot session/refresh-token cache (TTL'd). |
| `FLAGS` | KV | Operational flags, e.g. `LIVE_STREAMING_DISABLED`. |
| `MEDIA` | R2 | Avatars, tour images, recordings staging. Presigned PUT/GET only. |

## Environment variables

Non-secret values live in `[vars]` in `wrangler.toml`:

| Name | Description |
|---|---|
| `ENVIRONMENT` | `development` \| `staging` \| `production`. |
| `PUBLIC_SITE_ORIGIN` | Origin allowed by CORS in addition to the static allow-list. |

Secrets are set with `wrangler secret put NAME` and listed in
`.dev.vars.example`. Never commit `.dev.vars`.

## CORS

The allow-list is intentionally small:

- `https://tourcoaster.com`, `https://www.tourcoaster.com`
- `http://localhost:5000`, `http://0.0.0.0:5000` (Jekyll dev server)
- whatever you set in `PUBLIC_SITE_ORIGIN`

`CF-Access-Jwt-Assertion` is allow-listed for Phase 3.

## Adding a new migration

1. Create `migrations/000N_short_name.sql`. Include only forward-only SQL —
   D1 has no rollback runner. End with
   `INSERT INTO schema_version (version) VALUES (N);`.
2. Apply locally: `npm run db:migrate:local`.
3. Verify: `npx wrangler d1 execute tourcoaster --local --command "SELECT * FROM schema_version;"`.
4. Apply remotely once merged: `npm run db:migrate:remote`.

## Error contract

All errors return JSON:

```json
{ "error": { "code": "string", "message": "string", "requestId": "string" } }
```

Throw `AppError(status, code, message)` from anywhere to produce one. Unhandled
errors are logged with the request id and returned as `internal_error`.

## What's not here yet

This is the foundation only. Auth, business endpoints, payments, Stream
plumbing, and HTML routes ship in subsequent phases — see the project task
list in the parent repo.
