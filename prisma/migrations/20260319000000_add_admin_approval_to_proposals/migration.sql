-- Add pending_admin_approval to ProposalStatus enum
ALTER TYPE "app"."ProposalStatus" ADD VALUE IF NOT EXISTS 'pending_admin_approval' BEFORE 'sent';

-- Add approval/rejection tracking fields to proposals table
ALTER TABLE "app"."proposals"
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "approved_by" UUID,
  ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "rejected_by" UUID,
  ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "pdf_url" VARCHAR(1000);
