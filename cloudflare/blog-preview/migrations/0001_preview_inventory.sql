CREATE TABLE blog_import_files (
  path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, canonical TEXT
);
CREATE TABLE blog_import_records (
  record_key TEXT PRIMARY KEY, record_type TEXT NOT NULL, raw_json TEXT NOT NULL, sha256 TEXT NOT NULL
);
CREATE TABLE blog_slugs (
  slug TEXT PRIMARY KEY, ownership TEXT NOT NULL, owner_id TEXT NOT NULL, tombstone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE blog_migration_settings (
  setting TEXT PRIMARY KEY, value TEXT NOT NULL
);
INSERT INTO blog_migration_settings VALUES ('studio_read_only', 'true');
-- Staging archive only. No active grants, publish pointers, or production routes.
