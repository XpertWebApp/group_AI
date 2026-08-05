-- WBE Hotel Booking (XMLOUT) models.
--
-- Additive only: creates three new tables and one enum in the `app` schema.
-- No existing table is altered and no data is modified, so this migration is
-- safe to roll back by dropping the created objects.

-- CreateEnum
CREATE TYPE "app"."BookingFlowStatus" AS ENUM (
    'draft',
    'prebooked',
    'price_changed',
    'booking',
    'booked',
    'vouchered',
    'cancelled',
    'pending_cancellation',
    'failed'
);

-- CreateTable
CREATE TABLE "app"."bookings" (
    "id" UUID NOT NULL,
    "agency_reference" VARCHAR(64) NOT NULL,
    "booking_reference" VARCHAR(64),
    "provider_reference" VARCHAR(64),
    "status" "app"."BookingFlowStatus" NOT NULL DEFAULT 'draft',
    "wbe_status" VARCHAR(10),
    "session_id" VARCHAR(255) NOT NULL,
    "tid" VARCHAR(255) NOT NULL,
    "hotel_code" VARCHAR(255) NOT NULL,
    "hotel_name" VARCHAR(255),
    "destination_id" INTEGER,
    "destination_name" VARCHAR(255),
    "check_in_date" DATE NOT NULL,
    "check_out_date" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "prebooked_at" TIMESTAMP(3),
    "quoted_price" DECIMAL(12,2),
    "prebook_price" DECIMAL(12,2),
    "price_change_accepted_at" TIMESTAMP(3),
    "total_price" DECIMAL(12,2),
    "currency" VARCHAR(10),
    "non_refundable" BOOLEAN,
    "cancellation_deadline" TIMESTAMP(3),
    "cancellation_conditions" TEXT,
    "payment_option" INTEGER NOT NULL DEFAULT 1,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "hotel_notes" VARCHAR(250),
    "carbon_copy_mail" VARCHAR(255),
    "issue_voucher_on_book" BOOLEAN NOT NULL DEFAULT false,
    "vouchered_at" TIMESTAMP(3),
    "voucher_data" JSONB,
    "cancelled_at" TIMESTAMP(3),
    "cancellation_charge" DECIMAL(12,2),
    "supplier_code" VARCHAR(50),
    "essential_info" TEXT,
    "hotel_confirmation_number" VARCHAR(255),
    "original_provider_response" TEXT,
    "last_error" TEXT,
    "book_request_payload" JSONB,
    "book_response_payload" JSONB,
    "is_certification_test" BOOLEAN NOT NULL DEFAULT false,
    "certification_scenario" INTEGER,
    "request_id" UUID,
    "created_by_id" UUID,
    "booked_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."booking_rooms" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "room_id" INTEGER NOT NULL,
    "adults_no" INTEGER NOT NULL,
    "children_no" INTEGER NOT NULL,
    "room_description" VARCHAR(500),
    "meal_type" VARCHAR(10),
    "meal_name" VARCHAR(255),
    "price" DECIMAL(12,2),
    "optional_extras" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."booking_passengers" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "salutation" VARCHAR(10) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "is_child" BOOLEAN NOT NULL,
    "age" INTEGER,
    "is_leader" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_passengers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_agency_reference_key" ON "app"."bookings"("agency_reference");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_booking_reference_key" ON "app"."bookings"("booking_reference");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "app"."bookings"("status");

-- CreateIndex
CREATE INDEX "bookings_wbe_status_idx" ON "app"."bookings"("wbe_status");

-- CreateIndex
CREATE INDEX "bookings_request_id_idx" ON "app"."bookings"("request_id");

-- CreateIndex
CREATE INDEX "bookings_created_by_id_idx" ON "app"."bookings"("created_by_id");

-- CreateIndex
CREATE INDEX "bookings_check_in_date_idx" ON "app"."bookings"("check_in_date");

-- CreateIndex
CREATE INDEX "bookings_created_at_idx" ON "app"."bookings"("created_at");

-- CreateIndex
CREATE INDEX "bookings_is_certification_test_idx" ON "app"."bookings"("is_certification_test");

-- CreateIndex
CREATE INDEX "bookings_cancellation_deadline_idx" ON "app"."bookings"("cancellation_deadline");

-- CreateIndex
CREATE INDEX "booking_rooms_booking_id_idx" ON "app"."booking_rooms"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_rooms_booking_id_room_id_key" ON "app"."booking_rooms"("booking_id", "room_id");

-- CreateIndex
CREATE INDEX "booking_passengers_room_id_idx" ON "app"."booking_passengers"("room_id");

-- AddForeignKey
ALTER TABLE "app"."bookings" ADD CONSTRAINT "bookings_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "app"."booking_requests"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."bookings" ADD CONSTRAINT "bookings_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "auth"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."booking_rooms" ADD CONSTRAINT "booking_rooms_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "app"."bookings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."booking_passengers" ADD CONSTRAINT "booking_passengers_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "app"."booking_rooms"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
