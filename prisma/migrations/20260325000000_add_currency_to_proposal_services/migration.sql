-- Add currency column to proposal_services
ALTER TABLE "app"."proposal_services"
  ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10);
