-- AlterTable
-- Persisted at hotel-add time so the dashboard can deep-link the hotel
-- name into SETTHub on the Request Summary page. Nullable for older
-- rows + hotels without a synced masterHotelId.
ALTER TABLE "app"."proposal_hotels" ADD COLUMN "sethub_details_url" TEXT;
