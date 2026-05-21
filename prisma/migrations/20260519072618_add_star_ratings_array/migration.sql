-- AlterTable
ALTER TABLE "app"."booking_requests"
ADD COLUMN "star_ratings" DECIMAL(2,1)[] NOT NULL DEFAULT ARRAY[]::DECIMAL(2,1)[];

-- Backfill: every existing row with a non-null star_rating gets that single
-- value as a one-element array. Rows with NULL star_rating keep an empty
-- array — semantically equivalent to "any star" in the search pipeline.
UPDATE "app"."booking_requests"
SET "star_ratings" = ARRAY[star_rating]
WHERE star_rating IS NOT NULL AND COALESCE(array_length(star_ratings, 1), 0) = 0;
