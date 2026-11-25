-- Add address columns to proposal_hotels so the proposal-detail page can render
-- the hotel's location bar (street + city + country) without a separate join to
-- master.hotels. Frontend already sends these fields when staff add a hotel via
-- the dashboard; the AI auto-offer pipeline passes them from the search result.
-- AlterTable
ALTER TABLE "app"."proposal_hotels" ADD COLUMN     "address" TEXT,
ADD COLUMN     "address_city" VARCHAR(255),
ADD COLUMN     "address_country" VARCHAR(10);

-- Backfill historical rows from master.hotels by matching hotel_code.
-- Idempotent: only updates rows where address is currently NULL, so re-running
-- won't overwrite values supplied by the frontend on later add-hotel calls.
-- Rows whose hotel_code does not match master.hotels stay NULL (rare; e.g.
-- test fixtures like 'TEST_LOCKED' or stale codes).

UPDATE "app"."proposal_hotels" ph
SET address         = COALESCE(ph.address,         mh.address),
    address_city    = COALESCE(ph.address_city,    mh.address_city),
    address_country = COALESCE(ph.address_country, mh.address_country)
FROM "master"."hotels" mh
WHERE ph.hotel_code = mh.hotel_code
  AND (ph.address IS NULL OR ph.address_city IS NULL OR ph.address_country IS NULL)
  AND (mh.address IS NOT NULL OR mh.address_city IS NOT NULL OR mh.address_country IS NOT NULL);
