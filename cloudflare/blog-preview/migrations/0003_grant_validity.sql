-- Preserve scheduled/expiring access semantics from the existing CMS.
ALTER TABLE blog_access_grants ADD COLUMN starts_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blog_access_grants ADD COLUMN expires_at INTEGER;
