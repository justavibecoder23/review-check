# Blog Function storage reduction

The production reader used a dynamic public/ root, causing file tracing to package site assets into api/blog. Readers now anchor separately at public/blog.html and public/blog/snapshots. Existing slug validation and file bytes are unchanged; no route, CMS, media, auth, publication, or cache behavior is changed.

Local @vercel/nft tracing with installed lockfile dependencies: 107.813 MiB /1362 files before; 23.720 MiB /680 files after; 84.093 MiB reduction. Public files fall from715 to33, excluding all public/assets from the function while preserving normal static deployment output. macOS optional-native tracing warnings mean deployed Linux bundle size must still be verified on Vercel.

Validation: test:blog-publishing89/89 pass, including HTTP rewrite handling for all legacy snapshots, sitemap, and publication flows. Full npm test:952 pass,4 fail,1 skip, identical on baseline and patch. Existing failures:2 legal-page reproducibility expectations, TikTok sorting expectation, standalone Google-login HTTP script. Public files are unchanged. No QA article is added.

Deployment procedure: preserve active production and prior rollback; remove only the unaliased duplicate of the active commit; inspect a single preview's bundle and public routes; promote only after checks; compare article inventory and sitemap before/after. No CMS/Blob mutations during validation.
