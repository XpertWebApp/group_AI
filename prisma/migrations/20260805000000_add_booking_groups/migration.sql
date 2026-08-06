-- Booking groups: one customer-facing reservation spanning several supplier
-- bookings.
--
-- WBE caps how many rooms a single supplier will sell at once, so a group of
-- 15 rooms becomes several BookV2 calls and several `bookings` rows. This
-- migration adds the parent that ties those rows together and records how many
-- rooms were actually confirmed, which is what makes a part-booked group
-- visible instead of looking like a success.
--
-- Additive only: creates one enum and one table, and adds two nullable columns
-- to `bookings`. Existing rows are untouched — a booking made before this
-- migration simply has no group, which is the same shape as a standalone
-- booking made after it.

-- CreateEnum
CREATE TYPE "app"."BookingGroupStatus" AS ENUM (
    'pending',
    'booking',
    'confirmed',
    'partial',
    'failed',
    'cancelled'
);

-- CreateTable
CREATE TABLE "app"."booking_groups" (
    "id" UUID NOT NULL,
    "group_reference" VARCHAR(64) NOT NULL,
    "status" "app"."BookingGroupStatus" NOT NULL DEFAULT 'pending',
    "request_id" UUID NOT NULL,
    "proposal_id" UUID,
    "hotel_code" VARCHAR(255) NOT NULL,
    "hotel_name" VARCHAR(255),
    "check_in_date" DATE NOT NULL,
    "check_out_date" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "rooms_requested" INTEGER NOT NULL,
    "rooms_confirmed" INTEGER NOT NULL DEFAULT 0,
    "quoted_total" DECIMAL(12,2),
    "total_booked" DECIMAL(12,2),
    "currency" VARCHAR(10),
    "shortfall_note" TEXT,
    "created_by_id" UUID,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "booking_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_groups_group_reference_key"
    ON "app"."booking_groups"("group_reference");

CREATE INDEX "booking_groups_request_id_idx"  ON "app"."booking_groups"("request_id");
CREATE INDEX "booking_groups_proposal_id_idx" ON "app"."booking_groups"("proposal_id");
CREATE INDEX "booking_groups_status_idx"      ON "app"."booking_groups"("status");
CREATE INDEX "booking_groups_created_at_idx"  ON "app"."booking_groups"("created_at");

-- AddForeignKey
-- Cascade: a group booking has no meaning without its request.
ALTER TABLE "app"."booking_groups"
    ADD CONSTRAINT "booking_groups_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "app"."booking_requests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: the reservations outlive the proposal that produced them.
ALTER TABLE "app"."booking_groups"
    ADD CONSTRAINT "booking_groups_proposal_id_fkey"
    FOREIGN KEY ("proposal_id") REFERENCES "app"."proposals"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "app"."booking_groups"
    ADD CONSTRAINT "booking_groups_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "auth"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
-- Both nullable: a certification run or any single-supplier booking has no
-- group, and those rows must keep working unchanged.
ALTER TABLE "app"."bookings"
    ADD COLUMN "group_id"       UUID,
    ADD COLUMN "rooms_in_slice" INTEGER;

CREATE INDEX "bookings_group_id_idx" ON "app"."bookings"("group_id");

-- SetNull rather than Cascade: deleting a group must not delete the record of
-- reservations that exist at WBE. An orphaned booking row is recoverable; a
-- missing one is not.
ALTER TABLE "app"."bookings"
    ADD CONSTRAINT "bookings_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "app"."booking_groups"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
