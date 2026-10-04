# Shopee product metadata integration

## Implemented

### Independent exact-product source (2026-10-05)

The lookup order is now: existing five-day metadata cache → public exact-ID page → existing Shopee HTML/API probes → optional SEO search → existing detail Actor. Review collection runs independently and never awaits this chain. This replaces Actor-first identification; it does not change the review Actor, UI, Apify pool or budget rules.

`src/shopee-public-metadata.mjs` fetches `https://bangiare.com/san-pham-zk1.{itemId}.{shopId}.html`. It accepts only the main Product JSON-LD when the canonical URL, Product URL, SKU `1__{itemId}__{shopId}`, seller identifier and seller Shopee URL all match the requested product. Only the first trusted `susercontent.com/file/…` Product image is accepted. Recommendations, buyer photos, search snippets and a similar product's title/image are never substituted. This verifies the listing IDs in the source, not that its copy is current or that the cover image matches a selected `display_model_id` variant.

The public lookup has a 2.5-second deadline and a 512-KiB decompressed response limit. Redirects are not followed. `SHOPEE_PUBLIC_METADATA_ENABLED=false` disables this adapter. No image file is downloaded, stored in Blob or mirrored to another store: the browser loads the Shopee CDN URL.

SEO is **off by default**. Enabling it requires `SHOPEE_METADATA_SEO_ENABLED=true` and an existing `SERPAPI_API_KEY` or `GOOGLE_LENS_SERPAPI_KEY`. It uses Google Search, not Lens, with at most two ID queries and three candidate page fetches within an approximately four-second budget. Only matching Bangiare pages are supported by this adapter; their HTML is revalidated by the same parser. Search has its own provider quota and is not included in the Apify allowance. No paid search request was made during verification. Lens is not used for exact-listing identification because visual similarity does not prove `shopId:itemId`.

Success saves the name and image URL in the existing metadata cache and skips HTML/API/search/Actor fallbacks. Incomplete metadata on a review-cache hit also starts background hydration. Cached metadata is merged into that result rather than allowing an old empty review dataset to hide it. For a full pasted Shopee URL, public progress/result links retain that original URL and its variant parameters; backend collection still uses canonical IDs.

This release changes no Cloudflare schema, review Worker, Minecraft relay or production environment settings. It reuses the previously implemented D1 metadata endpoints below. The cache stores the source label and IDs; diagnostic events can include the source URL, but the existing D1 schema does not store that URL.

### Existing cache and background refresh

Metadata is keyed by the exact `shopId:itemId`. In D1/dual mode, the isolated Cloudflare review Worker stores title and image URL in `product_metadata_cache` for five days. Complete metadata skips the detail Actor even if Redis is unavailable. Reads and identical writes do not extend expiry. Partial updates preserve unexpired fields but never revive an expired image. The existing Redis metadata path remains only for legacy Blob mode and also uses a five-day TTL. Redis still provides Actor locks and the shared budget ledger, not D1-mode metadata storage. Image files are not uploaded or mirrored to Blob.

The existing D1 integration depends on `0002_product_metadata.sql` and the isolated review Worker's metadata endpoints. There is no new migration or Worker deployment for the 2026-10-05 public-source release. Worker metadata endpoints use the existing shared bearer secret. Do not change the Minecraft relay Worker or database.

The backend sends `product_meta` as soon as verified metadata arrives. Background work is registered through Vercel `waitUntil`. Review results do not await the Shopee metadata promise. A signed product-specific ticket permits the browser to request a bounded background refresh; subsequent GET polls only read cache. The per-product Redis lock prevents those two paths from starting concurrent paid runs. Late verified metadata updates progress, result, session storage and history, with analysis-generation guards.

The browser uses at most one POST and seven GET polls per analysis. An incomplete GET response does not prematurely stop polling an already pending run. Failed or incomplete paid runs enter a ten-minute cooldown. Ambiguous starts/billing retain a thirty-minute lock and the existing ledger's pending-cost policy; this is not an exactly-once guarantee.

`/api/shopee-product-meta` is rewritten to the existing analyze Function, preserving the project's twelve-Function count. Its implementation lives in `src/shopee-product-meta-route.mjs`.

## Shared budget

`shopee-product-detail` uses the existing Apify credential pool, reservation scripts and finalization ledger. It does not have a separate token, free-tier budget or five-run lifetime cap. Allocation includes observed spend, active reservations, the existing remaining Shopee review reserve, and the requested detail cost. Detail statistics are namespaced by the existing billing account and Apify cycle start. Lifetime Shopee review-use counters are not reset with those monthly statistics.

Initial settings: Actor `zen-studio/shopee-product-detail-scraper`; local deadline twelve seconds; maximum charge and reservation USD 0.05 per run. These are configurable safeguards, not measurements of production latency. Only exact-ID output and trusted Shopee product image URLs are accepted. Buyer review photos are not metadata fallbacks.

## Verification and rollout limits

Final targeted regression run: **98/98 passing**. Coverage includes exact public-source IDs, malformed/oversized/redirected HTML, SEO opt-in and request bounds, signed tickets/cross-origin rejection, cache-write failure, cached-review hydration, nonblocking late metadata, SQLite-backed D1 five-day cache, duplicate-run lock, ambiguous start, cooldown, shared budget/monthly statistics, TikTok, product-image loader and SSE. Budget assertions use an in-memory Redis adapter; they are not a production Redis integration test. No new paid Actor run or live SEO query was started during this implementation pass.

Live checks through the new adapter resolved both previously failing listings: `452200291:17701438002` and `1358301775:28661346083`. The first observed metadata latencies were 592 ms and 328 ms, respectively. These are single local observations, not production percentile measurements or a guarantee of availability for other products.

The broader `npm test` run before the final two route tests reported 907 passing, 4 failing, 1 skipped. Three failures are existing blog expectations (nine versus sixteen cards and dynamic versus snapshot sitemap); their relevant files are unchanged from base commit `6415687`. The fourth is the standalone Google HTTP harness requiring localhost:3137, unavailable in that run. No blog or sitemap fix was made as part of Shopee identification.

At the end of local verification on 2026-10-05, this implementation had not yet been committed, pushed or deployed. Deployment and live verification are recorded separately. Production acceptance still requires checking progress/result/history on the actual Vercel deployment, CDN image loading there, overall analysis latency and real cache reuse. Public-source coverage and freshness are not guaranteed. Keep existing D1 settings; do not restore Blob fallback. Roll back this source with `SHOPEE_PUBLIC_METADATA_ENABLED=false`; independently disable paid detail fallback with `SHOPEE_DETAIL_ACTOR_ENABLED=false` if needed.
