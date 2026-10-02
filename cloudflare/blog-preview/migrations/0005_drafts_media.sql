CREATE TABLE blog_drafts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  body_json TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX blog_drafts_updated ON blog_drafts(updated_at DESC, id);
CREATE TABLE blog_revisions (
  post_id TEXT NOT NULL REFERENCES blog_drafts(id),
  revision INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY(post_id, revision)
);
-- A failed assertion rolls back the ENTIRE D1 batch; successful markers are
-- deleted in the same batch and never become durable application state.
CREATE TABLE blog_commit_checks (
  token TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok = 1)
);
CREATE TABLE blog_media (
  hash TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'ready')),
  owner TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence > 0),
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER
);
CREATE INDEX blog_media_pending ON blog_media(state, lease_until);
