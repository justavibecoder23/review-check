-- Preserve recovery locators without inventing historical revision bodies.
CREATE TABLE blog_legacy_locators (
  record_key TEXT PRIMARY KEY,
  pointer_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'legacy_unrecoverable' CHECK(state='legacy_unrecoverable')
);
