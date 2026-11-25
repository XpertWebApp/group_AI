-- Backfill proposal_hotels.star_rating from master.hotels.star_rating.
--
-- Historical bug: offerGeneration.service.ts didn't pass starRating to addHotelTx(),
-- so ~95% of proposal_hotel rows were stored with NULL star_rating even though the
-- value was available on the auto-offer search result. The bug is fixed in code;
-- this migration backfills the historical rows by joining to master.hotels.
--
-- master.hotels.star_rating is Decimal(2,1); proposal_hotels.star_rating is Int.
-- FLOOR() matches the floorStarRating() utility used in the repository.
-- Idempotent: rows already populated are not touched (WHERE ph.star_rating IS NULL).
-- Rows whose hotel_code does not match master.hotels stay NULL.

UPDATE app.proposal_hotels ph
SET star_rating = FLOOR(mh.star_rating)::int
FROM master.hotels mh
WHERE ph.hotel_code = mh.hotel_code
  AND ph.star_rating IS NULL
  AND mh.star_rating IS NOT NULL;
