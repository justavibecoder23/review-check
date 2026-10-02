-- Classify blocked legacy pointers separately; NEVER modify original record/hash.
CREATE TABLE blog_legacy_state (
  record_key TEXT PRIMARY KEY REFERENCES blog_import_records(record_key),
  state TEXT NOT NULL CHECK(state = 'legacy_unrecoverable')
);
INSERT INTO blog_legacy_state(record_key, state)
SELECT record_key, 'legacy_unrecoverable' FROM blog_import_records
WHERE record_key LIKE 'realview:blog:cms:v1:post:%:revision:%'
  AND CASE WHEN json_valid(json_extract(raw_json, '$'))
    THEN json_extract(json_extract(raw_json, '$'), '$.storage') END = 'vercel-blob-private';

-- Existing static/snapshot ownership wins. Legacy aliases and archived slugs
-- remain reserved without inventing redirects or public tombstone behaviour.
WITH metas AS (
  SELECT record_key, json_extract(raw_json, '$') AS meta FROM blog_import_records
  WHERE record_key LIKE 'realview:blog:cms:v1:post:%:meta'
)
INSERT OR IGNORE INTO blog_slugs(slug, ownership, owner_id, tombstone)
SELECT value, 'legacy_reserved', record_key, 0 FROM metas,
  json_each(json_array(json_extract(meta, '$.slug'), json_extract(meta, '$.publishedSlug')))
WHERE value IS NOT NULL AND value <> '';

WITH metas AS (
  SELECT record_key, json_extract(raw_json, '$') AS meta FROM blog_import_records
  WHERE record_key LIKE 'realview:blog:cms:v1:post:%:meta'
)
INSERT OR IGNORE INTO blog_slugs(slug, ownership, owner_id, tombstone)
SELECT value, 'legacy_reserved', record_key, 0 FROM metas, json_each(meta, '$.managedSlugs')
WHERE value IS NOT NULL AND value <> '';
