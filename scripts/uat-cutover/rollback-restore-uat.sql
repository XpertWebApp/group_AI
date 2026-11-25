-- ============================================================================
-- UAT CUTOVER — Rollback: restore uat_archive.* back to master.*
-- ============================================================================
-- Purpose:
--   Undo the archive step (script 01) by moving the tables back from
--   uat_archive to master. Use this if the cutover needs to be reversed
--   before LIVE sync begins.
--
-- What this does:
--   1. Drops the fresh empty master.* tables (created by script 02).
--   2. Moves uat_archive.* tables back into master schema.
--   3. Drops the (now empty) uat_archive schema.
--
-- WARNING:
--   Only run if you have NOT yet started LIVE static-data sync.
--   Once LIVE data has been written into the fresh master tables, this
--   rollback will DROP that LIVE data. Read the "Guard" section below.
--
-- Guarantees:
--   - Wrapped in a single transaction.
--   - Guard fails loudly if any of the fresh master.* tables contains rows.
--
-- Note on app-tables truncate:
--   The `03-truncate-app-tables.sql` step is NOT reversible from this script.
--   Truncated rows are gone. Restore from a DB backup if that data is needed.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/uat-cutover/rollback-restore-uat.sql
-- ============================================================================

BEGIN;

-- ---- Guard: refuse to rollback if fresh master tables already hold LIVE data
DO $$
DECLARE
  populated text;
  row_total bigint;
BEGIN
  SELECT string_agg(t.table_name || ' (' || r.rows::text || ')', ', ')
    INTO populated
    FROM (VALUES
      ('destinations'), ('hotels'), ('hotel_images'), ('facilities'),
      ('hotel_facilities'), ('hotel_facility_groups'),
      ('hotel_giata_texts'), ('hotel_giata_facts'),
      ('hotel_giata_images'), ('hotel_giata_mappings')
    ) AS t(table_name)
    CROSS JOIN LATERAL (
      SELECT COALESCE((xpath('/row/c/text()',
        query_to_xml(format('SELECT count(*) AS c FROM master.%I', t.table_name), false, true, '')
      ))[1]::text::bigint, 0) AS rows
    ) r
    WHERE r.rows > 0;
  IF populated IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: fresh master tables already contain data: %. Restore from backup instead.', populated;
  END IF;
END $$;

-- ---- Drop the fresh empty master tables
DROP TABLE IF EXISTS master.hotel_giata_mappings   CASCADE;
DROP TABLE IF EXISTS master.hotel_giata_images     CASCADE;
DROP TABLE IF EXISTS master.hotel_giata_facts      CASCADE;
DROP TABLE IF EXISTS master.hotel_giata_texts      CASCADE;
DROP TABLE IF EXISTS master.hotel_facility_groups  CASCADE;
DROP TABLE IF EXISTS master.hotel_facilities       CASCADE;
DROP TABLE IF EXISTS master.facilities             CASCADE;
DROP TABLE IF EXISTS master.hotel_images           CASCADE;
DROP TABLE IF EXISTS master.hotels                 CASCADE;
DROP TABLE IF EXISTS master.destinations           CASCADE;

-- ---- Move archived tables back
ALTER TABLE uat_archive.destinations          SET SCHEMA master;
ALTER TABLE uat_archive.hotels                SET SCHEMA master;
ALTER TABLE uat_archive.hotel_images          SET SCHEMA master;
ALTER TABLE uat_archive.facilities            SET SCHEMA master;
ALTER TABLE uat_archive.hotel_facilities      SET SCHEMA master;
ALTER TABLE uat_archive.hotel_facility_groups SET SCHEMA master;
ALTER TABLE uat_archive.hotel_giata_texts     SET SCHEMA master;
ALTER TABLE uat_archive.hotel_giata_facts     SET SCHEMA master;
ALTER TABLE uat_archive.hotel_giata_images    SET SCHEMA master;
ALTER TABLE uat_archive.hotel_giata_mappings  SET SCHEMA master;

-- ---- Drop empty uat_archive schema
DROP SCHEMA IF EXISTS uat_archive RESTRICT;

COMMIT;

\echo '=== Rollback complete. master schema restored with UAT data: ==='
SELECT 'destinations'         AS table_name, count(*) AS row_count FROM master.destinations
UNION ALL SELECT 'hotels',                    count(*) FROM master.hotels
UNION ALL SELECT 'hotel_images',              count(*) FROM master.hotel_images
UNION ALL SELECT 'facilities',                count(*) FROM master.facilities
UNION ALL SELECT 'hotel_facilities',          count(*) FROM master.hotel_facilities
UNION ALL SELECT 'hotel_facility_groups',     count(*) FROM master.hotel_facility_groups
UNION ALL SELECT 'hotel_giata_texts',         count(*) FROM master.hotel_giata_texts
UNION ALL SELECT 'hotel_giata_facts',         count(*) FROM master.hotel_giata_facts
UNION ALL SELECT 'hotel_giata_images',        count(*) FROM master.hotel_giata_images
UNION ALL SELECT 'hotel_giata_mappings',      count(*) FROM master.hotel_giata_mappings;
