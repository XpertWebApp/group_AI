/*
  Warnings:

  - The `status` column on the `booking_requests` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `proposals` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "app"."BookingRequestStatus" AS ENUM ('pending', 'draft', 'processing', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "app"."ProposalStatus" AS ENUM ('draft', 'sent', 'approved', 'declined');

-- AlterTable
ALTER TABLE "app"."booking_requests" ALTER COLUMN "nationality_code" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "app"."BookingRequestStatus" NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "app"."proposal_hotels" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "option_details_fetched" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "tid" DROP NOT NULL;

-- AlterTable
ALTER TABLE "app"."proposals" ADD COLUMN     "locked_at" TIMESTAMP(3),
ADD COLUMN     "locked_by" UUID,
ADD COLUMN     "sent_at" TIMESTAMP(3),
ADD COLUMN     "sent_by" UUID,
ADD COLUMN     "sent_to_email" VARCHAR(255),
DROP COLUMN "status",
ADD COLUMN     "status" "app"."ProposalStatus" NOT NULL DEFAULT 'draft';

-- CreateTable
CREATE TABLE "audit"."audit_events" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "details" JSONB,
    "ip_address" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."booking_request_attachments" (
    "id" UUID NOT NULL,
    "booking_request_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "original_name" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100),
    "size" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_request_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_entityId_idx" ON "audit"."audit_events"("entityId");

-- CreateIndex
CREATE INDEX "audit_events_entity_entityId_created_at_idx" ON "audit"."audit_events"("entity", "entityId", "created_at");

-- CreateIndex
CREATE INDEX "booking_request_attachments_booking_request_id_idx" ON "app"."booking_request_attachments"("booking_request_id");

-- CreateIndex
CREATE INDEX "booking_requests_status_idx" ON "app"."booking_requests"("status");

-- CreateIndex
CREATE INDEX "proposal_hotels_proposal_id_deleted_at_idx" ON "app"."proposal_hotels"("proposal_id", "deleted_at");

-- CreateIndex
CREATE INDEX "proposals_status_idx" ON "app"."proposals"("status");

-- CreateIndex
CREATE INDEX "proposals_sent_at_idx" ON "app"."proposals"("sent_at");

-- CreateIndex
CREATE INDEX "proposals_locked_at_idx" ON "app"."proposals"("locked_at");

-- CreateIndex
CREATE INDEX "hotels_destination_id_name_idx" ON "master"."hotels"("destination_id", "name");

-- AddForeignKey
ALTER TABLE "app"."booking_request_attachments" ADD CONSTRAINT "booking_request_attachments_booking_request_id_fkey" FOREIGN KEY ("booking_request_id") REFERENCES "app"."booking_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
