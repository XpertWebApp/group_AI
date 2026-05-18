-- Add contact_phone_country_code column to booking_requests
ALTER TABLE "app"."booking_requests"
  ADD COLUMN IF NOT EXISTS "contact_phone_country_code" VARCHAR(8);
