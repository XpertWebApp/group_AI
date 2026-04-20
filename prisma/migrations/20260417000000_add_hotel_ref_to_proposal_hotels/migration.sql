-- AlterTable
ALTER TABLE "app"."proposal_hotels" ADD COLUMN "hotel_ref" VARCHAR(32);

-- Backfill: SETT-{request.reference_number}-{seq zero-padded to 3}
-- Sequence is per-proposal, ordered by created_at (then id for tiebreak).
WITH numbered AS (
    SELECT ph.id,
           br.reference_number AS ref_num,
           ROW_NUMBER() OVER (PARTITION BY ph.proposal_id ORDER BY ph.created_at, ph.id) AS seq
    FROM "app"."proposal_hotels" ph
    JOIN "app"."proposals" p ON p.id = ph.proposal_id
    JOIN "app"."booking_requests" br ON br.id = p.request_id
)
UPDATE "app"."proposal_hotels" ph
SET "hotel_ref" = 'SETT-' || n.ref_num || '-' || LPAD(n.seq::text, 3, '0')
FROM numbered n
WHERE ph.id = n.id AND ph."hotel_ref" IS NULL;

-- Unique per proposal — prevents duplicate refs under concurrent inserts.
CREATE UNIQUE INDEX "proposal_hotels_proposal_id_hotel_ref_key"
    ON "app"."proposal_hotels" ("proposal_id", "hotel_ref");
