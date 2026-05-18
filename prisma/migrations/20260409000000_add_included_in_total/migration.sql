-- Add included_in_total flag to proposal_hotels and proposal_services
-- Default TRUE so all existing rows are included in proposal totals

ALTER TABLE "app"."proposal_hotels"
  ADD COLUMN IF NOT EXISTS "included_in_total" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "app"."proposal_services"
  ADD COLUMN IF NOT EXISTS "included_in_total" BOOLEAN NOT NULL DEFAULT TRUE;
