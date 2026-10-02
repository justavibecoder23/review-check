-- No legacy grant is activated by this migration. Missing grant/settings deny writes.
CREATE TABLE blog_access_grants (
  actor_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE blog_request_replays (
  environment TEXT NOT NULL CHECK (environment IN ('preview', 'production')),
  request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (environment, request_id)
);
CREATE INDEX blog_request_replays_expiry ON blog_request_replays(expires_at);
CREATE TABLE blog_idempotency (
  environment TEXT NOT NULL CHECK (environment IN ('preview', 'production')),
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
  response_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (environment, actor_id, operation, idempotency_key)
);
CREATE INDEX blog_idempotency_expiry ON blog_idempotency(expires_at);
