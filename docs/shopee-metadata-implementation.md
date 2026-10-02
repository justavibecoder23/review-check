# Shopee product metadata integration

## Implemented

Metadata is keyed by the exact `shopId:itemId`. In D1/dual mode, the isolated Cloudflare review Worker stores title and image URL in `product_metadata_cache` for five days. Complete metadata skips the detail Actor even if Redis is unavailable. Reads and identical writes do not extend expiry. Partial updates preserve unexpired fields but never revive an expired image. The existing Redis metadata path remains only for legacy Blob mode and also uses a five-day TTL. Redis still provides Actor locks and the shared budget ledger, not D1-mode metadata storage. Image files are not uploaded or mirrored to Blob.

Before enabling this version on Vercel, apply `0002_product_metadata.sql` to the preview and production review D1 databases and deploy the updated isolated review Worker. Do not change the Minecraft relay Worker or database. The migration is additive and does not delete reviews. Worker metadata endpoints use the existing shared bearer secret.

The backend sends `product_meta` as soon as verified metadata arrives. Background work is registered through Vercel `waitUntil`. Review results do not await the Shopee metadata promise. A signed product-specific ticket permits the browser to request a bounded background refresh; subsequent GET polls only read cache. The per-product Redis lock prevents those two paths from starting concurrent paid runs. Late verified metadata updates progress, result, session storage and history, with analysis-generation guards.

The browser uses at most one POST and seven GET polls per analysis. An incomplete GET response does not prematurely stop polling an already pending run. Failed or incomplete paid runs enter a ten-minute cooldown. Ambiguous starts/billing retain a thirty-minute lock and the existing ledger's pending-cost policy; this is not an exactly-once guarantee.

`/api/shopee-product-meta` is rewritten to the existing analyze Function, preserving the project's twelve-Function count. Its implementation lives in `src/shopee-product-meta-route.mjs`.

## Shared budget

`shopee-product-detail` uses the existing Apify credential pool, reservation scripts and finalization ledger. It does not have a separate token, free-tier budget or five-run lifetime cap. Allocation includes observed spend, active reservations, the existing remaining Shopee review reserve, and the requested detail cost. Detail statistics are namespaced by the existing billing account and Apify cycle start. Lifetime Shopee review-use counters are not reset with those monthly statistics.

Initial settings: Actor `zen-studio/shopee-product-detail-scraper`; local deadline twelve seconds; maximum charge and reservation USD 0.05 per run. These are configurable safeguards, not measurements of production latency. Only exact-ID output and trusted Shopee product image URLs are accepted. Buyer review photos are not metadata fallbacks.

## Verification and rollout limits

Targeted tests cover ID validation, duplicate-run lock, ambiguous start, cooldown, signed tickets, free fallback, nonblocking late metadata, shared budget/monthly statistics, D1 cache, TikTok and SSE. Budget assertions use an in-memory Redis adapter; they are not a production Redis integration test. No new paid Actor run was started during this implementation pass.

Production acceptance still requires a bounded real run on the failing links, checking correct IDs/title/image, metadata latency, final result latency, history updates and final cost. A passing mock does not establish Actor availability or production latency. Keep existing D1 settings; do not restore Blob fallback. Roll back new paid detail runs with `SHOPEE_DETAIL_ACTOR_ENABLED=false`.
