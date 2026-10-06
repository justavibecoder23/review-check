# Blog Cloudflare production cutover, 2026-10-07

## Scope

Blog Studio backend uses the dedicated `realview-blog` Worker, D1 database and private `realview-blog-media` R2 bucket. Account/session infrastructure remains unchanged. The review-cache database and Minecraft relay are not modified. Vercel still serves the frontend and CDN; this is not a migration of the entire website hosting.

Existing public HTML is served byte for byte from snapshots. Opening an old article is read-only. Its first explicit save creates revision 1 in D1; publishing is a separate action. Old Blob revision bodies were inaccessible and were not reconstructed. Their 54 locators remain marked `legacy_unrecoverable`, outside the Studio revision list.

## Verified

- 19 snapshot HTML hashes match D1 and the staged HTTP responses.
- Blog index and sitemap match the existing snapshots.
- 6 existing grants were mapped to verified stable account IDs. No new production permission was granted.
- 42 targeted tests pass, covering auth, denied writes, revision conflicts, idempotency, publication ordering and tombstones.
- Live private save/retry and R2 upload tests passed. Exact test drafts and image objects were cleaned up; no test publication was created.
- Full regression: 940 pass, 7 fail, 1 skip. The same 7 failures occur on the original HEAD baseline; migration adds no failing test.
- Deployment `dpl_EUQLcxdMFkVNhzAyfgiccBtQaRpQ` was promoted; D1 authoritative read-only flag was then disabled.

## Security and remaining limitations

Worker validates environment-specific HMAC, replay IDs and active grants. Commits recheck permissions. Public media requires a published reference; R2 direct public access is disabled. Production routing cannot fall back to legacy Blob/Redis CMS.

Existing slug renames are currently refused rather than creating unsafe aliases. Historical Blob revisions are not available. Public HTML uses a 60-second CDN TTL and tag invalidation with revision confirmation; cache misses still incur Vercel/Worker/D1 requests. This does not imply zero usage or global instantaneous invalidation.

The signed-in account `nhantriet1674` is not one of the migrated production grants. Its earlier preview-only approval is not production authorization; grant access requires a separate explicit decision.

The encrypted cutover backup is in Documents/secret. Keys are not in Git or Cloudflare. The user authorized this location despite possible iCloud synchronization; it is not proof of an independent offline backup.
