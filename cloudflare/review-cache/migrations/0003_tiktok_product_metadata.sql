CREATE TABLE IF NOT EXISTS tiktok_product_metadata_cache (
  product_id TEXT PRIMARY KEY CHECK(length(product_id) BETWEEN 8 AND 25 AND product_id NOT GLOB '*[^0-9]*'),
  title TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  rating REAL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tiktok_metadata_expiry ON tiktok_product_metadata_cache(expires_at);
