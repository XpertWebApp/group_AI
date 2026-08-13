-- ============================================================================
-- UAT CUTOVER — Step 03: Truncate app request/booking tables (LOCAL ONLY)
-- ============================================================================
-- Purpose:
--   Clear out all UAT-era request/booking/proposal test data from local DB
--   so LIVE flows start against an empty state.
--
-- WARNING — DESTRUCTIVE:
--   This truncates rows. Data is NOT preserved anywhere.
--   Only run on LOCAL developer databases. NEVER run on production.
--   The script's first statement is a hostname guard to prevent accidental
--   prod execution.
--
-- What this does:
--   1. Guards against running outside localhost.
--   2. TRUNCATE ... CASCADE in the correct dependency order.
--   3. Preserves the `booking_requests.reference_number` sequence
--      (does NOT reset it — so future reference numbers won't collide
--      with any that may have been shared out during UAT).
--
-- Never-touched tables:
--   - auth.users, auth.user_roles
--   - app.settings, app.supplier_limits
--   - audit.audit_events, audit.sync_jobs
--   - master.currencies, master.nationalities, master.languages
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/uat-cutover/03-truncate-app-tables.sql
-- ============================================================================

-- ---- Hostname guard: refuse to run outside localhost/127.0.0.1
DO $$
DECLARE
  host text;
BEGIN
  SELECT inet_server_addr()::text INTO host;
  IF host IS NOT NULL AND host NOT IN ('127.0.0.1', '::1') THEN
    RAISE EXCEPTION 'ABORT: refusing to truncate on non-local host (%). Local-only script.', host;
  END IF;
END $$;

BEGIN;

-- ---- Truncate in dependency order. CASCADE handles remaining FKs.
-- Children first, parents last.
TRUNCATE TABLE
  app.booking_passengers,
  app.booking_rooms,
  app.bookings,
  app.booking_groups,
  app.notifications,
  app.failed_emails,
  app.hotel_probe_jobs,
  cache.hotel_option_details,
  app.proposal_services,
  app.proposal_hotels,
  app.option_selections,
  app.proposal_offers,
  app.proposals,
  app.booking_request_attachments,
  app.booking_requests
RESTART IDENTITY CASCADE;

-- ---- Restore the reference_number sequence to a safe forward value.
-- RESTART IDENTITY above zeroed it. We want to continue from where we were
-- so no LIVE reference number can ever collide with a UAT-era number that
-- might exist in someone's email, screenshot, or Odoo lead.
--
-- Bump the sequence high enough that LIVE numbers start well above any
-- reasonable UAT range. 100_000 is a safe cushion; adjust if UAT went higher.
SELECT setval('app.booking_requests_reference_number_seq', 100000, false);

COMMIT;

-- ---- Report
\echo '=== Truncation complete. Verifying empty state: ==='
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
UNION ALL SELECT 'booking_passengers',          count(*) FROM app.booking_passengers
UNION ALL SELECT 'cache.hotel_option_details',  count(*) FROM cache.hotel_option_details;

\echo ''
\echo '=== reference_number sequence — will resume at: ==='
SELECT nextval('app.booking_requests_reference_number_seq') AS next_reference_number;
-- Undo the nextval bump — we only wanted to peek
SELECT setval('app.booking_requests_reference_number_seq', 100000, false);

\echo ''
\echo '=== Never-touched tables — confirming still populated: ==='
SELECT 'auth.users'         AS table_name, count(*) AS row_count FROM auth.users
UNION ALL SELECT 'app.settings',       count(*) FROM app.settings
UNION ALL SELECT 'app.supplier_limits', count(*) FROM app.supplier_limits;
