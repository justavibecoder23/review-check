# TikTok product metadata: Redis to D1, five-day cache

Implementation date: 2026-10-05. Code and local tests completed. Migration 0003 and the preview/production Workers have been deployed; Vercel rollout follows the main push.

## Scope and unchanged systems

Only the TikTok product-name/image-URL metadata overlay changes storage. Review datasets already use their existing D1 backend and five-day eligibility policy. Shopee metadata, the Actor credential pool, cost reservations, billing-cycle counters, session storage, rate limits, UI, Blog Studio, published articles and Minecraft relay are not migrated or modified by this change.

The cache stores URLs, not image bytes. No image mirroring, R2 upload or Blob call is introduced. Old Redis metadata is not bulk-imported or deleted; its existing Redis expiry can run naturally.

## Schema and API

Apply `cloudflare/review-cache/migrations/0003_tiktok_product_metadata.sql` using Wrangler migrations. This additive migration creates `tiktok_product_metadata_cache` and its expiry index. It can be reapplied without dropping existing rows.

The existing review-cache Worker exposes authenticated GET/POST `/v1/tiktok-product-metadata` using its existing `REVIEW_CACHE_SECRET`. Credentials remain server-side. The existing Shopee route remains separate.

Product IDs must be digit strings with 8–25 characters, never JavaScript numbers. The client verifies that returned IDs match the requested ID. Titles use the existing quality validator. Images must be HTTPS URLs on explicitly trusted TikTok CDN domains, without credentials or a custom port. Original signed query parameters are retained. This is a URL safety policy, not proof that every regional CDN or signed URL remains accessible for five days.

## Expiration, ordering and cleanup

New observations expire at `observedAt + 5 days`. Exactly at expiry, reads miss. Reading, copying a cached overlay, or posting unchanged fields does not refresh expiry. Historical review metadata is not promoted to a new observation. Complete, recent metadata already in a review dataset avoids a separate metadata GET/POST.

The Worker uses a single atomic UPSERT with an observation-time guard. A late older observation cannot overwrite an accepted newer observation. Partial fresh writes can retain still-valid old fields, but keep the earlier expiry when retaining any old field. Expired fields are not resurrected. Thus a partial entry can live less than five days, never more because it reused an older image.

Expiration is immediate eligibility loss, not immediate physical deletion. Hourly cron `17 * * * *` deletes at most 500 expired TikTok rows per execution. It never deletes fresh rows, Shopee rows or review datasets. Capacity is up to 12,000 deleted records/day; actual D1 rows written can exceed deleted records because index maintenance is billable. A full batch emits a warning; repeated full batches require monitoring and adjustment, not an assumption that backlog is zero. No new external alert receiver is configured.

Read/write/cleanup structured logs distinguish D1 `rows_read`, `rows_written` and deleted records (`meta.changes`). Worker log sampling remains configured at 10%; sampled logs do not constitute an exact account-wide billing ledger. Use Cloudflare analytics for actual usage.

## Backend flags and failures

`TIKTOK_METADATA_BACKEND=d1` explicitly selects the new overlay. Without that flag, the overlay follows `REVIEW_DATASET_BACKEND`: `d1`/`dual` selects D1, while legacy `blob` selects Redis. Invalid override values are rejected.

An explicit `TIKTOK_METADATA_BACKEND=redis` is a metadata-only rollback. It retains the legacy Redis 30-day policy, not the new D1 five-day policy. Do not change the review backend to roll back this overlay. D1 failures do not silently fall back to Redis or Blob.

Cache reads are best effort. Writes are registered with the existing `onBackgroundWork`/Vercel `waitUntil` integration; a slow or failed write does not hold up a fresh result. When no background hook is provided (local callers), the function awaits the write. Metadata reads and the existing page fallback still have bounded network latency; this change does not claim zero additional latency for cache misses or an unavailable Worker.

## Rollout order

1. Apply migration 0003 to the review-cache **preview** database.
2. Deploy the review-cache preview Worker, including cron, after the table exists.
3. Deploy a Vercel preview configured with the preview Worker URL/secret and `TIKTOK_METADATA_BACKEND=d1`.
4. Check exact product IDs, actual CDN image rendering, expiry, Worker errors and D1 usage with a bounded number of requests. Do not start paid Actors just to validate cache storage.
5. After preview acceptance, apply the same migration to the production review-cache database, deploy its Worker, then deploy Vercel. Preserve all existing review/Shopee tables and credentials.

Never deploy the Vercel reader before the Worker/schema. A Worker without the table would return storage errors; a cron without the table would fail. Cloudflare account access was revalidated during rollout; the earlier authorization/account error 7403 no longer blocked deployment.

## Infrastructure rollout evidence

Migration 0003 was the only pending migration and applied successfully to both configured databases. Remote SELECT queries confirmed the new table and expiry index. No data import or paid Actor run was performed; the production metadata table was initially empty.

* Preview Worker version: `6b179cf4-4203-45b7-8d7d-72aaaa5a6ed3`.
* Production Worker version: `d0ebc3f8-950e-4a2c-ac0a-cab7b1ce5670`.
* Both deployments registered hourly cron `17 * * * *` and retained the existing secrets.
* Both health endpoints returned HTTP 200; metadata requests without a credential returned HTTP 401.
* Production Vercel was configured with `TIKTOK_METADATA_BACKEND=d1` before the main push. Existing review-cache credentials and Actor pool variables were not changed.

These checks establish schema/deployment readiness and mandatory authentication, not a successful authenticated metadata write/read through the production application. Do not treat HTTP health or deployment READY as evidence of an end-to-end product analysis or production cache hit.

## Verification and cost limits

The tests use in-memory SQLite behind a D1-compatible adapter and a real Worker request dispatcher. They verify exact IDs, expiry at five days, unchanged-write suppression, partial-field expiry, older-write rejection, schema reapplication, auth/input validation, full D1 review-cache reuse, Actor-title priority, background-write failure and bounded cleanup. Redis, Blob and extra Actor access are forbidden by stubs in the new D1 scenarios.

SQLite test row counters are not actual Cloudflare usage. This migration removes Redis metadata traffic only; sessions, pool locks and rate limits still use Redis. D1/Worker requests, index writes and storage still consume the account's allowances. No claim is made that all Redis usage becomes zero or that production cost has already been measured.

References checked for the implementation:

* [Cloudflare D1 return metadata](https://developers.cloudflare.com/d1/worker-api/return-object/)
* [Cloudflare D1 pricing and index-write accounting](https://developers.cloudflare.com/d1/platform/pricing/)
