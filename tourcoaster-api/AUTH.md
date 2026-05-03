# Authentication — Cloudflare Access + Google

TourCoaster uses **Cloudflare Access** with **Google** as the only identity
provider. The API does not store passwords, does not run an OAuth flow itself,
and does not integrate any other auth SaaS. Cloudflare Access fronts the
protected URLs, runs the Google sign-in flow, and drops a signed JWT cookie.
The Worker verifies that JWT on every protected request.

## How it works (request lifecycle)

1. Browser hits a protected URL (e.g. `https://tourcoaster.com/dashboard/`).
2. Cloudflare Access intercepts → redirects to Google → user signs in.
3. Access drops the **`CF_Authorization`** cookie on `tourcoaster.com` and
   redirects back to the original URL.
4. Browser calls `https://api.tourcoaster.com/v1/me` with
   `credentials: 'include'`. The cookie rides along on the same eTLD+1, and
   Cloudflare also sets the `Cf-Access-Jwt-Assertion` request header on the
   backend hop.
5. Worker middleware (`requireAccessAuth`) verifies the JWT against
   Cloudflare's JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`),
   checking issuer + audience + RS256 signature.
6. On first sight of a user, the Worker `INSERT`s a row into `users` keyed by
   email (with `google_sub` = JWT `sub`). On every later request it reuses
   the existing row.
7. Role lives in our DB, not in Access. New users have `role = NULL` until
   they call `POST /v1/auth/role`.

## Cloudflare configuration (one-time, in Zero Trust)

1. **Zero Trust → Settings → Authentication → Login methods** — add Google.
   Either Google Workspace SSO or a Google OAuth client works; OAuth client
   is simpler for a single-tenant launch.
2. **Access → Applications** — create three **Self-hosted** applications:

   | Application | Domain | Path | Policy |
   |---|---|---|---|
   | TourCoaster API | `api.tourcoaster.com` | `/v1/*` | Allow: emails ending `@*` (i.e. anyone with Google) |
   | TourCoaster Dashboard | `tourcoaster.com` | `/dashboard/*` | Same |
   | TourCoaster Watch | `tourcoaster.com` | `/watch/*` | Same |

   For each application:
   - Set **Session duration** to 24h (or whatever feels right).
   - Set **Identity providers** to just Google.
   - Copy the application **AUD tag** — this is `CF_ACCESS_AUD` in
     `wrangler.toml` / `.dev.vars`. Each app has its own AUD; for now we use
     a single Worker AUD for the API. If you want one-AUD-per-app, accept an
     allow-list inside `verifyAccessJwt`.

3. **Bypass policies** for public API endpoints. Inside the *TourCoaster API*
   Access app, add **Bypass** policies (above the Allow policy) for:

   - `GET /v1/health`
   - `GET /v1/guides/*` (added in a later phase)
   - `GET /v1/tours/*` (added in a later phase)

   Bypass means Cloudflare never challenges the user; the Worker still
   handles the request normally. Unauthenticated callers will simply not have
   a JWT, and our middleware is only mounted on protected sub-routers, so
   public routes serve normally.

4. **Team domain** — Zero Trust → Settings → General → "Team domain". This
   is `CF_ACCESS_TEAM_DOMAIN` (e.g. `tourcoaster.cloudflareaccess.com`).

## Worker configuration

Set in `wrangler.toml` `[vars]` (not secrets — they're public values):

```toml
CF_ACCESS_TEAM_DOMAIN = "tourcoaster.cloudflareaccess.com"
CF_ACCESS_AUD = "abcdef0123456789..."
```

For local development, override in `.dev.vars`:

```
CF_ACCESS_TEAM_DOMAIN=tourcoaster.cloudflareaccess.com
CF_ACCESS_AUD=abcdef0123456789...
```

Production — same values via `wrangler.toml` per environment, or
`wrangler secret put` if you'd rather treat them as secrets.

## API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | public | liveness |
| GET | `/v1/me` | required | current user + (if guide) profile |
| POST | `/v1/auth/role` | required, role must be NULL | one-shot pick `traveler`\|`guide` |
| POST | `/v1/auth/logout` | required | clear `CF_Authorization` + `CF_AppSession`, returns 204 |

`requireRole(...roles)` is exported from `src/auth/middleware.ts` for later
phases. `'admin'` is granted access to anything.

## Promoting a user to admin

There is no self-serve admin endpoint. Promote manually:

```bash
npx wrangler d1 execute tourcoaster --remote \
  --command "UPDATE users SET role='admin', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email='you@example.com';"
```

## Frontend integration

The Jekyll site loads `/assets/js/auth.js` on `/login`, `/signup`, and
`/dashboard/`. It tags the `<body>` with `data-auth-page="login|signup|dashboard"`
to choose its bootstrap path.

- On `/login` and `/signup`, clicking "Continue with Google" navigates to
  `/dashboard/` — Cloudflare Access intercepts and runs the Google flow.
- On `/dashboard/`, the script calls `GET /v1/me`. If `role` is null, it
  redirects back to `/login` (where the role-picker UI takes over after the
  Access cookie is present). Otherwise it shows the dashboard.
- Sign-out posts to `/v1/auth/logout` then sends the user to
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout` to terminate
  the Access session globally. Set `window.TOURCOASTER_CF_TEAM` (e.g. via a
  small inline `<script>` rendered from `_data/general_settings.yml`) to
  enable the global logout redirect.

## Threat notes

- JWT verification uses `jose` with the JWKS from Cloudflare. JWKS is cached
  in-memory per isolate for 10 minutes with a 30-second cooldown on misses.
- `iss` and `aud` are pinned. Algorithm pinned to `RS256`.
- The session cookie is `HttpOnly`, `Secure`, set by Cloudflare. We never
  read or set the cookie value ourselves; logout deletes it (with `Secure`
  and `SameSite=Lax`) and redirects through Access's logout endpoint.
- **Identity binding.** `users.google_sub` (the Cloudflare Access JWT
  `sub`) is the canonical identity key, not email. Provisioning resolves
  in this order:
  1. lookup by `google_sub` — if found, follow any email change;
  2. lookup by `email` — only re-bind to the new subject when
     `google_sub IS NULL` (e.g. a seeded admin row);
  3. otherwise insert a new row.

  "Same email, different subject" returns **409 `identity_conflict`** and
  must be merged manually in D1 by an admin. We never silently overwrite
  an existing row's `google_sub` based on email alone — that would allow
  account takeover if a Google email were recycled.

  Both `google_sub` and `email` are UNIQUE in D1; concurrent first-sight
  inserts that race lose to a UNIQUE constraint and the loser retries
  the SELECT.
