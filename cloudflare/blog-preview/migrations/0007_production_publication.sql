ALTER TABLE blog_drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived'));
ALTER TABLE blog_drafts ADD COLUMN published_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blog_drafts ADD COLUMN published_at TEXT;
CREATE TABLE blog_published (
  slug TEXT PRIMARY KEY REFERENCES blog_slugs(slug),
  post_id TEXT NOT NULL REFERENCES blog_drafts(id),
  revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  html TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX blog_published_post ON blog_published(post_id);
CREATE TABLE blog_public_media (
  slug TEXT NOT NULL REFERENCES blog_slugs(slug),
  hash TEXT NOT NULL REFERENCES blog_media(hash),
  PRIMARY KEY(slug,hash)
);
CREATE INDEX blog_public_media_hash ON blog_public_media(hash);
CREATE TABLE blog_legacy_articles (
  slug TEXT PRIMARY KEY REFERENCES blog_slugs(slug),
  summary_json TEXT NOT NULL,
  html_sha256 TEXT NOT NULL,
  source_path TEXT NOT NULL
);
CREATE TABLE blog_access_audit (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, target_id TEXT NOT NULL,
  action TEXT NOT NULL, created_at TEXT NOT NULL
);
ALTER TABLE blog_access_grants ADD COLUMN email TEXT;
ALTER TABLE blog_access_grants ADD COLUMN display_name TEXT;
