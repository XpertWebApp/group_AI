-- Cancellation-deadline override on ProposalHotel.
--
-- Adds three nullable columns. Purely additive — existing rows are
-- unaffected, no application code needs to change for read paths until
-- the new override-aware logic ships in the same deploy.
--
-- Semantics:
--  - cancel_deadline_override:     staff-edited override (effective date)
--  - cancel_deadline_overridden_by: user UUID who set/cleared it
--  - cancel_deadline_overridden_at: timestamp of the most recent change
--
-- The original supplier date stays in cancel_deadline (never overwritten).

-- AlterTable
ALTER TABLE "app"."proposal_hotels"
    ADD COLUMN "cancel_deadline_override"    TIMESTAMPTZ(6),
    ADD COLUMN "cancel_deadline_overridden_by" UUID,
    ADD COLUMN "cancel_deadline_overridden_at" TIMESTAMPTZ(6);
