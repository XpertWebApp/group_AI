-- Per-offer German policy translations (auto-generated via free translator)
ALTER TABLE "app"."booking_requests"
  ADD COLUMN "terms_and_conditions_de" TEXT,
  ADD COLUMN "cancellation_conditions_de" TEXT;
