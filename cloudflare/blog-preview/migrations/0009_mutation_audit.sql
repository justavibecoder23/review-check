CREATE TABLE blog_mutation_audit (
  request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  post_id TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX blog_mutation_audit_post ON blog_mutation_audit(post_id,created_at DESC);
