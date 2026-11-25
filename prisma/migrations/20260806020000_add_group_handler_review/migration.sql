-- Group handler review on a booking group.
--
-- The client requires a person to check a completed booking — hotel, rooms,
-- rates, margins, cancellation and payment terms, supplier references, and the
-- Odoo sales order — before the customer-facing offer is sent:
--
--   "The customer-facing offer must not be sent before this review is
--    completed."
--
-- These columns are what makes that gate enforceable. reviewed_at being null is
-- the block; the reviewer is named rather than flagged because the review is the
-- last check before a customer is held to a price.
--
-- Additive only: five nullable columns on an existing table. Groups created
-- before this migration are simply unreviewed, which is the correct reading —
-- nobody has checked them.

-- AlterTable
ALTER TABLE "app"."booking_groups"
    ADD COLUMN "reviewed_at"             TIMESTAMP(3),
    ADD COLUMN "reviewed_by_id"          UUID,
    ADD COLUMN "review_notes"            TEXT,
    ADD COLUMN "review_rejected_at"      TIMESTAMP(3),
    ADD COLUMN "review_rejection_reason" TEXT;

-- CreateIndex
-- The staff worklist is "groups awaiting review", so that filter is the one
-- that has to stay fast as completed groups accumulate.
CREATE INDEX "booking_groups_reviewed_at_idx" ON "app"."booking_groups"("reviewed_at");

-- AddForeignKey
-- SetNull: a departed reviewer must not take the record of the review with
-- them; reviewed_at still says it happened.
ALTER TABLE "app"."booking_groups"
    ADD CONSTRAINT "booking_groups_reviewed_by_id_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "auth"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
