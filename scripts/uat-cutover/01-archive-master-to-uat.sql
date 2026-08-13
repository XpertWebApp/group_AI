-- ============================================================================
-- UAT CUTOVER — Step 01: Archive master static tables into uat_archive schema
-- ============================================================================
-- Purpose:
--   Move the 10 WBE-synced static tables from `master.*` to `uat_archive.*`
--   so LIVE sync can start fresh, without deleting a single row of UAT data.
--
-- What this does:
--   1. Creates schema `uat_archive` (if not exists).
--   2. ALTER TABLE ... SET SCHEMA — atomic, preserves all data, indexes, PKs.
--   3. Does NOT touch: currencies, nationalities, languages (reference data).
--   4. Does NOT touch: app/auth/audit/cache/settings/supplier_limits.
--
-- Reversibility:
--   Fully reversible via rollback-restore-uat.sql (moves back to master schema).
--
-- Guarantees:
--   - Wrapped in a single transaction. If any ALTER fails, nothing changes.
--   - Fails loudly if a target archive table already exists (no silent overwrite).
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/uat-cutover/01-archive-master-to-uat.sql
-- ============================================================================

BEGIN;

-- ---- Guard 1: uat_archive schema must not already contain a conflicting table
DO $$
DECLARE
  conflicting text;
BEGIN
  SELECT string_agg(table_name, ', ')
    INTO conflicting
    FROM information_schema.tables
   WHERE table_schema = 'uat_archive'
     AND table_name IN (
       'destinations', 'hotels', 'hotel_images', 'facilities',
       'hotel_facilities', 'hotel_facility_groups',
       'hotel_giata_texts', 'hotel_giata_facts',
       'hotel_giata_images', 'hotel_giata_mappings'
     );
  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: uat_archive schema already contains: %. Refusing to overwrite.', conflicting;
  END IF;
END $$;

-- ---- Create archive schema
CREATE SCHEMA IF NOT EXISTS uat_archive;

-- ---- Move each static table (schema move is atomic + preserves everything)
ALTER TABLE master.destinations           SET SCHEMA uat_archive;
ALTER TABLE master.hotels                 SET SCHEMA uat_archive;
ALTER TABLE master.hotel_images           SET SCHEMA uat_archive;
ALTER TABLE master.facilities             SET SCHEMA uat_archive;
ALTER TABLE master.hotel_facilities       SET SCHEMA uat_archive;
ALTER TABLE master.hotel_facility_groups  SET SCHEMA uat_archive;
ALTER TABLE master.hotel_giata_texts      SET SCHEMA uat_archive;
ALTER TABLE master.hotel_giata_facts      SET SCHEMA uat_archive;
ALTER TABLE master.hotel_giata_images     SET SCHEMA uat_archive;
ALTER TABLE master.hotel_giata_mappings   SET SCHEMA uat_archive;

-- ---- Confirm move succeeded
DO $$
DECLARE
  moved_count int;
BEGIN
  SELECT count(*) INTO moved_count
    FROM information_schema.tables
   WHERE table_schema = 'uat_archive'
     AND table_name IN (
       'destinations', 'hotels', 'hotel_images', 'facilities',
       'hotel_facilities', 'hotel_facility_groups',
       'hotel_giata_texts', 'hotel_giata_facts',
       'hotel_giata_images', 'hotel_giata_mappings'
     );
  IF moved_count <> 10 THEN
    RAISE EXCEPTION 'ABORT: expected 10 tables in uat_archive, found %. Rolling back.', moved_count;
  END IF;
END $$;

COMMIT;

-- ---- Report
\echo '=== Archive complete. Tables now in uat_archive schema: ==='
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'uat_archive'
 ORDER BY table_name;

\echo ''
\echo '=== master schema — remaining tables (should be currencies/nationalities/languages only): ==='
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'master'
 ORDER BY table_name;
