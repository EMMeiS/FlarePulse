-- The project rename, Levix -> FlarePulse.
--
-- Migrations are append-only, so 0003's `site_name TEXT NOT NULL DEFAULT 'Levix'`
-- stays as written and this file corrects the one row that default ever produced.
-- It runs after 0003 on a fresh database and after the old default on an existing
-- one, so both end up on the new name.
--
-- Guarded on the old value: an operator who has already set their own site name
-- through the Settings tab keeps it.
UPDATE settings SET site_name = 'FlarePulse' WHERE site_name = 'Levix';
