-- AlterTable: add google_email column to store the connected Gmail address (per-user)
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "google_email" VARCHAR(255);
