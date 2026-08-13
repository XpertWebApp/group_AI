-- ============================================================================
-- UAT CUTOVER — Pre-flight checks
-- ============================================================================
-- Purpose: Verify current DB state BEFORE running any rename/truncate scripts.
-- Safe to run repeatedly. Read-only.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/uat-cutover/00-preflight-checks.sql
--
-- Expected output (before running cutover):
--   - master schema: all 10 static tables present, non-zero rowcounts
--   - uat_archive schema: does NOT exist yet
--   - app schema: request/booking tables present (rowcounts vary)
-- ============================================================================

\echo '=== Schemas present ==='
SELECT schema_name
FROM information_schema.schemata
WHERE schema_name IN ('master', 'app', 'cache', 'auth', 'audit', 'uat_archive')
ORDER BY schema_name;

\echo ''
\echo '=== master schema — static table rowcounts (tables to rename) ==='
SELECT 'destinations'          AS table_name, count(*) AS row_count FROM master.destinations
UNION ALL SELECT 'hotels',                    count(*) FROM master.hotels
UNION ALL SELECT 'hotel_images',              count(*) FROM master.hotel_images
UNION ALL SELECT 'facilities',                count(*) FROM master.facilities
UNION ALL SELECT 'hotel_facilities',          count(*) FROM master.hotel_facilities
UNION ALL SELECT 'hotel_facility_groups',     count(*) FROM master.hotel_facility_groups
UNION ALL SELECT 'hotel_giata_texts',         count(*) FROM master.hotel_giata_texts
UNION ALL SELECT 'hotel_giata_facts',         count(*) FROM master.hotel_giata_facts
UNION ALL SELECT 'hotel_giata_images',        count(*) FROM master.hotel_giata_images
UNION ALL SELECT 'hotel_giata_mappings',      count(*) FROM master.hotel_giata_mappings;

\echo ''
\echo '=== master schema — reference tables (NOT touched by cutover) ==='
SELECT 'currencies'    AS table_name, count(*) AS row_count FROM master.currencies
UNION ALL SELECT 'nationalities', count(*) FROM master.nationalities
UNION ALL SELECT 'languages',     count(*) FROM master.languages;

\echo ''
\echo '=== app schema — request/booking tables (to be truncated) ==='
SELECT 'booking_requests'            AS table_name, count(*) AS row_count FROM app.booking_requests
UNION ALL SELECT 'booking_request_attachments', count(*) FROM app.booking_request_attachments
UNION ALL SELECT 'proposals',                   count(*) FROM app.proposals
UNION ALL SELECT 'proposal_offers',             count(*) FROM app.proposal_offers
UNION ALL SELECT 'option_selections',           count(*) FROM app.option_selections
UNION ALL SELECT 'proposal_hotels',             count(*) FROM app.proposal_hotels
UNION ALL SELECT 'proposal_services',           count(*) FROM app.proposal_services
UNION ALL SELECT 'notifications',               count(*) FROM app.notifications
UNION ALL SELECT 'failed_emails',               count(*) FROM app.failed_emails
UNION ALL SELECT 'hotel_probe_jobs',            count(*) FROM app.hotel_probe_jobs
UNION ALL SELECT 'booking_groups',              count(*) FROM app.booking_groups
UNION ALL SELECT 'bookings',                    count(*) FROM app.bookings
UNION ALL SELECT 'booking_rooms',               count(*) FROM app.booking_rooms
UNION ALL SELECT 'booking_passengers',          count(*) FROM app.booking_passengers;

\echo ''
\echo '=== cache schema ==='
SELECT 'hotel_option_details' AS table_name, count(*) AS row_count FROM cache.hotel_option_details;

\echo ''
\echo '=== NEVER-TOUCH tables (audit / auth / settings / supplier_limits) ==='
SELECT 'auth.users'          AS table_name, count(*) AS row_count FROM auth.users
UNION ALL SELECT 'auth.user_roles',   count(*) FROM auth.user_roles
UNION ALL SELECT 'app.settings',      count(*) FROM app.settings
UNION ALL SELECT 'app.supplier_limits', count(*) FROM app.supplier_limits
UNION ALL SELECT 'audit.audit_events', count(*) FROM audit.audit_events
UNION ALL SELECT 'audit.sync_jobs',   count(*) FROM audit.sync_jobs;

\echo ''
\echo '=== reference_number sequence — current value ==='
SELECT
  sequence_schema,
  sequence_name,
  (SELECT last_value FROM app.booking_requests_reference_number_seq) AS current_last_value
FROM information_schema.sequences
WHERE sequence_schema = 'app'
  AND sequence_name = 'booking_requests_reference_number_seq';

\echo ''
\echo '=== Pre-flight complete. Review the numbers above before running cutover scripts. ==='
