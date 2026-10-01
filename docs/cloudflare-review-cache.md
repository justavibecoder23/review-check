# Review storage on Cloudflare D1

The `realview-review-cache` Worker and D1 database are independent of
`wwpk-cloudflare-relay`, its URL, secrets and `RELAY` Durable Object namespace.
Deploy only with `cloudflare/review-cache/wrangler.jsonc`. Do not use the Minecraft
project's Wrangler configuration or add a D1 binding to its Worker.

## Data and expiry

Datasets retain the exact schema v2 bundle, raw review order, labeled review order,
product metadata, run IDs and timestamps. Legacy raw/labeled pairs are combined
without changing either envelope. Reviews are stored individually so a bundle
larger than D1's 2 MB row limit still fits; bundles remain limited to 10 MB, each
row to 1.9 MB, and combined raw/labeled rows to 800.

An atomic batch stores the complete dataset and publishes its product pointer.
A transaction failure leaves neither partial review entries nor a cache pointer.
Live identical fingerprints reuse the original dataset for five days. Imports
are idempotent by full bundle SHA-256. Older imports cannot replace newer cache.
`expires_at = created_at + 5 days`; reading never extends that deadline. The
existing Shopee sampling and TikTok minimum-review rules still apply, and an
unfinished Actor run cannot seed cache.

Expiry is not deletion. Historical datasets remain stored, just like old Blob
objects. No cleanup schedule or deletion of Blob data is enabled. Storage must be
monitored as archives grow; 5 GB is included across D1 databases, with a 10 GB
limit per paid database. The preview database is separate from production.

## Application configuration

* `CLOUDFLARE_REVIEW_CACHE_URL`: HTTPS URL of the RealView Worker.
* `CLOUDFLARE_REVIEW_CACHE_SECRET`: separate service credential, stored as a Worker
  secret and a Vercel environment variable. Never send it to a browser.
* `REVIEW_DATASET_BACKEND=blob`: original behavior, instant rollback.
* `REVIEW_DATASET_BACKEND=dual`: write both stores concurrently, read Blob.
* `REVIEW_DATASET_BACKEND=d1`: read/write D1 first.
* `REVIEW_DATASET_BLOB_FALLBACK=true`: use the old backend if D1 is unavailable or
  has no eligible cache. Disable only after verifying migration coverage.

Cloudflare requests have a 2.5 second application deadline. Storage errors do not
discard an analysis result. Dataset persistence remains at the existing saving
stage. No Actor credentials, reservations, quotas, scoring, SSE event contracts,
account-history format, or product-image files are migrated by this change.

## Deployment and migration

1. Record the Minecraft production deployment and Durable Object binding.
2. Apply D1 migrations and deploy the preview Worker. Configure its secret.
3. Run Worker/SQLite tests, then bounded reads and writes against preview D1.
4. Apply the schema and deploy the production RealView Worker with its own secret.
5. Run `node --env-file=.vercel/.env.review-migration.local
   tools/migrate-review-datasets-to-d1.mjs --all --report=data/cloudflare-review-migration-audit.json`
   for inventory. Add `--apply` after checking the report. The command performs
   one-time Blob listing and reads; it never deletes or overwrites Blob objects.
6. Each imported bundle is downloaded from D1 and compared by full SHA-256.
   Missing legacy pairs and unavailable Blob objects are reported, not invented.
7. Enable D1 in a Vercel preview, check exact-product cache hits and latency, then
   deploy to production. For this cutover, `REVIEW_DATASET_BACKEND=d1` and
   `REVIEW_DATASET_BLOB_FALLBACK=false` are required: no review read/write falls
   back to the blocked Blob store.
8. Confirm the Minecraft deployment and binding are unchanged.

Cloudflare Worker requests/CPU are metered across the paid account. D1 and Durable
Object storage appear as different usage meters. Keep separate logs and metrics
for the RealView Worker. Worker logs contain dataset IDs/counts and usage metrics,
not review text, author identities or credentials.

## Cutover decision, October 1, 2026

The old private Blob store returns HTTP 403 with `Your store is blocked`.
Listing found 905 objects and 478 dataset candidates, but none could be read.
Following the owner's instruction, migration of old objects is stopped; they
are neither deleted nor described as migrated. D1 starts with an empty production
cache. The first eligible successful Actor result populates it for five days.
Existing user history in Redis is not erased or rewritten.

The isolated preview passed full-bundle hash verification for 100 Shopee reviews
and 200 TikTok reviews. Writes took 801/632 ms; ten cache reads took 226–383 ms
from the test machine, not an end-to-end Vercel latency benchmark. The application
limits each D1 network call to 2.5 seconds. A cache outage becomes a miss, while
a storage outage is reported without losing the current analysis result.
45 targeted storage, cache, metadata and SSE tests passed. The full repository
suite also has four unrelated failures (three existing blog/sitemap assertions
and the HTTP Google-login test requiring a local server).

The Minecraft relay remained on version
`8356fd4b-7fb5-4952-b4bb-d4fc1fec0453` before and after RealView Worker deployment.

Production cutover deployed successfully as Vercel deployment
`dpl_219yCknoWRVivUsVbHcnCmtoiHj9`, aliased to `www.realview.com.vn`.
Production Worker health and authenticated cache lookup returned HTTP 200;
the expected first lookup was a miss. Both Vercel environments are configured
with D1 as backend and Blob fallback disabled. No paid Actor run was initiated
for these infrastructure tests; an actual first analysis/cache-hit round trip
has not been measured yet.
