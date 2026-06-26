-- Payment deadline on Proposal.
--
-- Adds three nullable columns. Purely additive — existing rows are
-- unaffected, no application code needs to change for read paths until
-- the new payment-deadline-aware logic ships in the same deploy.
--
-- Semantics:
--  - payment_deadline:         staff-set date by which the customer must pay
--  - payment_deadline_set_by:  user UUID who set/changed/cleared it (audit)
--  - payment_deadline_set_at:  timestamp of the most recent change (audit)
--
-- There is NO default — the field stays null until staff explicitly sets it.
-- The Send Offer flow refuses to send when it's null.
--
-- Application-layer guard enforces that the payment deadline must be:
--   1. In the future (>= today)
--   2. Earlier than the earliest effective cancellation deadline across
--      all ProposalHotel rows on this proposal (so the customer pays
--      before the cancellation window closes).

-- AlterTable
ALTER TABLE "app"."proposals"
    ADD COLUMN "payment_deadline"        TIMESTAMPTZ(6),
    ADD COLUMN "payment_deadline_set_by" UUID,
    ADD COLUMN "payment_deadline_set_at" TIMESTAMPTZ(6);
