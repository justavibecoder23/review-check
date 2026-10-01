PRAGMA foreign_keys = ON;

CREATE TABLE review_datasets (
  id TEXT PRIMARY KEY,
  product_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  header_json TEXT NOT NULL,
  raw_count INTEGER NOT NULL,
  labeled_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  imported_from TEXT,
  stored_at INTEGER NOT NULL
);
CREATE INDEX review_datasets_product ON review_datasets(product_key, created_at DESC);

CREATE TABLE review_entries (
  dataset_id TEXT NOT NULL REFERENCES review_datasets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('raw', 'labeled')),
  position INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id, kind, position)
);

CREATE TABLE review_cache_latest (
  product_key TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES review_datasets(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE review_write_dedupe (
  dedupe_key TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES review_datasets(id),
  expires_at INTEGER NOT NULL
);

-- Expiry controls eligibility only. Historical datasets are retained, like Blob.
-- No scheduled deletion is enabled by this migration.
