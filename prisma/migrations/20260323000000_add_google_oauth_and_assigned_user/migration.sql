-- Add Google OAuth token fields to users table
ALTER TABLE "auth"."users"
  ADD COLUMN IF NOT EXISTS "google_access_token" TEXT,
  ADD COLUMN IF NOT EXISTS "google_refresh_token" TEXT,
  ADD COLUMN IF NOT EXISTS "google_token_expiry" TIMESTAMPTZ;

-- Add assigned_user_id to booking_requests (links request to the staff user)
ALTER TABLE "app"."booking_requests"
  ADD COLUMN IF NOT EXISTS "assigned_user_id" UUID;

-- Index for filtering requests by assigned user
CREATE INDEX IF NOT EXISTS "booking_requests_assigned_user_id_idx"
  ON "app"."booking_requests" ("assigned_user_id");
