-- Migration: Create Request Figma fields
-- Adds all fields required by the 4-step Create Request UI flow

-- referenceNumber: sequential display ID (#2458 style)
CREATE SEQUENCE IF NOT EXISTS "app"."booking_requests_reference_number_seq";

ALTER TABLE "app"."booking_requests"
  ADD COLUMN IF NOT EXISTS "reference_number"        INT DEFAULT nextval('"app"."booking_requests_reference_number_seq"') NOT NULL,

  -- Step 1: Trip Details
  ADD COLUMN IF NOT EXISTS "checkout_date"           DATE,
  ADD COLUMN IF NOT EXISTS "star_rating"             DECIMAL(2,1),
  ADD COLUMN IF NOT EXISTS "budget_range"            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "group_type"              VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "group_size"              INT,

  -- Step 2: Room & Accommodations
  ADD COLUMN IF NOT EXISTS "breakfast_preference"    VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "hotel_location"          VARCHAR(50),

  -- Step 3: Customer Details
  ADD COLUMN IF NOT EXISTS "first_name"              VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "last_name"               VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "guest_list_file_key"     TEXT,
  ADD COLUMN IF NOT EXISTS "customer_notes"          TEXT,

  -- Step 4: Policies
  ADD COLUMN IF NOT EXISTS "terms_and_conditions"    TEXT,
  ADD COLUMN IF NOT EXISTS "cancellation_conditions" TEXT;

-- Unique constraint on reference_number
CREATE UNIQUE INDEX IF NOT EXISTS "booking_requests_reference_number_key"
  ON "app"."booking_requests"("reference_number");

-- Indexes for search/filter performance
CREATE INDEX IF NOT EXISTS "booking_requests_reference_number_idx"
  ON "app"."booking_requests"("reference_number");

CREATE INDEX IF NOT EXISTS "booking_requests_company_name_idx"
  ON "app"."booking_requests"("company_name");
