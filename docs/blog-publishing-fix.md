# Blog Studio publishing fix

Base: main d4ffa3f966829e366fa4d05b27ff98e50140aa56, including PR55.

- Completed Studio commands retire their idempotency key; unresolved retries keep the same key. Concurrent identical requests share one flight. Only hashed fingerprints and random keys are saved in sessionStorage for reload recovery, never draft text.
- Legacy article URLs use the existing CMS public handler. Snapshot records return the original file; draft edits cannot replace public HTML; published revisions and tombstones are authoritative. CMS errors stay503, never resurrecting removed content via fallback.
- Publishing checks the article revision, blog membership and sitemap membership. Durable commits with incomplete public visibility return202 with per-surface checks. Studio updates its saved state and offers a persistent verification button. Authenticated GET verify_publication rechecks current revision/status without any publication mutation.
- Sitemap generation, public article assets/content, slugs, canonical URLs and publication dates are unchanged. Two existing date tests also fail on unmodified main: expected dates were stale. Only test expectations were updated to the existing frozen dates.

Validation: npm run test:blog-publishing (89 tests). Added GitHub Actions regression workflow; repository branch protection must require its regression check to enforce blocking merges (not changed by this patch). The workflow runs on the PR and matching main pushes.

Read-only baseline: 20 public articles200; 26 sitemap entries. Candidate/live comparison PASS: all20 article HTML hashes unchanged after CRLF normalization; all26 sitemap entries including lastmod/image metadata unchanged. CMS comparison: 19 snapshot records and one published record; no current route/CMS content conflict. Local HTTP requests exercise all19 configured legacy rewrites, GET/HEAD original bytes, published revision and410 tombstones. No production mutation was performed.

Browser QA uses in-memory SQLite and mocked authentication only. A publish commits once, shows pending visibility, then verification completes without another publish. Preview public routes also use the same public CMS as production, without enabling preview admin writes. Hosted preview preservation is checked read-only before rollout.

Rollout: review preservation evidence first, then deploy from a commit including PR55. Recheck every baseline article and sitemap after deployment using read-only requests. Do not publish/unpublish existing articles as a deploy smoke test. No SQL migration, bulk import or republish is needed.

Rollback: before any legacy publication mutation, restore the previously recorded deployment if necessary. Once legacy articles have been updated/removed via CMS, retain CMS article routing when rolling back Studio/verification code; restoring static rewrites could revive removed content. Never roll back PR55's hub/sitemap rewrites. No database rollback is required.
