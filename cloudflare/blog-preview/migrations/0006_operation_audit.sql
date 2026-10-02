CREATE TABLE blog_operation_audit (
  request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('save','media-upload')),
  body_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','finished')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status INTEGER,
  error_code TEXT,
  metrics_json TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX blog_operation_audit_expiry ON blog_operation_audit(expires_at);
CREATE TABLE blog_media_put_audit (
  request_id TEXT NOT NULL REFERENCES blog_operation_audit(request_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
  pathname TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('attempted','confirmed','condition-not-met','unknown')),
  attempted_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(request_id,ordinal)
);
