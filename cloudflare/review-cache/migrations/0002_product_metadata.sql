CREATE TABLE IF NOT EXISTS product_metadata_cache (
  product_key TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT,
  image_url TEXT,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
