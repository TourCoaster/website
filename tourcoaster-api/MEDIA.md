# Media — R2 + presigned avatar uploads

Avatars (and any public images later) live in the R2 bucket bound as
`MEDIA` (`tourcoaster-media`). Uploads use **presigned PUT URLs** so the
bytes never touch the Worker.

## Buckets and bindings

`wrangler.toml` already binds:

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "tourcoaster-media"
preview_bucket_name = "tourcoaster-media-preview"
```

Create them once:

```bash
npx wrangler r2 bucket create tourcoaster-media
npx wrangler r2 bucket create tourcoaster-media-preview
```

## Object key layout

| Use | Key shape |
|---|---|
| Guide avatars | `avatars/<userId>/<uuid>.<ext>` |

The Worker enforces ownership: a `PATCH /v1/guides/me { avatar_key }` is
rejected unless the key starts with `avatars/<callerUserId>/`.

## Read path — `GET /v1/media/<key>`

Public. Served by the Worker reading the R2 binding directly. Returns the
object's stored `Content-Type` plus
`Cache-Control: public, max-age=86400, immutable` and the R2 `ETag`. Hot
reads are cheap and CDN-cacheable; we don't pay R2 egress because the bucket
is bound, not fetched over S3.

The public guide HTML page references avatars as
`https://api.tourcoaster.com/v1/media/avatars/<userId>/<uuid>.jpg`.

## Write path — presigned PUT

`POST /v1/guides/me/avatar` (auth: guide):

```json
{ "contentType": "image/jpeg" }   // or image/png, image/webp
```

Response:

```json
{
  "uploadUrl": "https://<account>.r2.cloudflarestorage.com/tourcoaster-media/avatars/<uid>/<uuid>.jpg?X-Amz-...",
  "key": "avatars/<uid>/<uuid>.jpg",
  "contentType": "image/jpeg",
  "maxBytes": 5242880,
  "expiresIn": 600
}
```

The browser then issues:

```http
PUT <uploadUrl>
Content-Type: image/jpeg
Body: <bytes>
```

The `avatar_key` is persisted on the guide's profile by the presign call
itself, so no follow-up PATCH is needed — the upload only delivers bytes
to a key the server has already committed to. (If the PUT fails, the next
successful presign+upload overwrites the unused key; orphaned bytes in R2
are cleaned up by a background sweep.) `PATCH /v1/guides/me { avatar_key }`
remains supported for explicit clears (`avatar_key: null`) and
ownership-checked overrides.

## R2 S3 credentials

`presignPut` uses Cloudflare's S3-compatible endpoint
(`https://<account>.r2.cloudflarestorage.com`). Required values:

| Name | Where | Notes |
|---|---|---|
| `R2_ACCOUNT_ID` | `[vars]` in `wrangler.toml` | Cloudflare account id (public) |
| `R2_BUCKET_NAME` | `[vars]` in `wrangler.toml` | `tourcoaster-media` |
| `R2_ACCESS_KEY_ID` | secret (`wrangler secret put`) | from R2 → Manage R2 API Tokens |
| `R2_SECRET_ACCESS_KEY` | secret (`wrangler secret put`) | same |

Create the API token in **R2 → Manage R2 API Tokens** with **Object Read &
Write** scope on `tourcoaster-media`.

## CORS on the bucket

The R2 bucket needs CORS so the browser can PUT directly:

```bash
npx wrangler r2 bucket cors put tourcoaster-media --rules '[
  {
    "AllowedOrigins": ["https://tourcoaster.com", "http://localhost:5000"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 600
  }
]'
```

## Local development

`presignPut` will throw `503 r2_not_configured` until you populate
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID`. Avatar uploads
require real R2 — there is no local-only fallback. Profile editing without
avatar still works against Wrangler's local D1.
