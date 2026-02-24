-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "app";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "cache";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "master";

-- CreateTable
CREATE TABLE "auth"."user_roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password" TEXT NOT NULL,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "role_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master"."destinations" (
    "id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "country_code" VARCHAR(10),
    "region" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMP(3),
    "metadata" JSONB,
    "parent_id" INTEGER,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master"."currencies" (
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "master"."nationalities" (
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nationalities_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "master"."languages" (
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "languages_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "master"."hotels" (
    "hotel_code" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "master_hotel_id" INTEGER,
    "hotel_details_url" TEXT,
    "destination_id" INTEGER,
    "star_rating" DECIMAL(2,1),
    "category" VARCHAR(50),
    "giata_code" VARCHAR(50),
    "address" TEXT,
    "address_city" VARCHAR(255),
    "address_country" VARCHAR(10),
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "property_type" INTEGER,
    "supplier_code" VARCHAR(50),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMP(3),
    "details_fetched_at" TIMESTAMP(3),

    CONSTRAINT "hotels_pkey" PRIMARY KEY ("hotel_code")
);

-- CreateTable
CREATE TABLE "master"."facilities" (
    "id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master"."hotel_facilities" (
    "id" UUID NOT NULL,
    "hotel_code" VARCHAR(255) NOT NULL,
    "facility_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotel_facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master"."hotel_images" (
    "id" UUID NOT NULL,
    "hotel_code" VARCHAR(64) NOT NULL,
    "image_key" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "caption" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotel_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master"."hotel_facility_groups" (
    "id" UUID NOT NULL,
    "hotel_code" VARCHAR(64) NOT NULL,
    "group_type" VARCHAR(20) NOT NULL,
    "category" VARCHAR(255),
    "facilities" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotel_facility_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."booking_requests" (
    "id" UUID NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "external_request_id" VARCHAR(255),
    "source" VARCHAR(100),
    "source_ip" VARCHAR(50),
    "budget" DECIMAL(12,2),
    "company_name" VARCHAR(255),
    "contact_name" VARCHAR(255),
    "contact_email" VARCHAR(255),
    "contact_phone" VARCHAR(50),
    "currency_code" VARCHAR(10),
    "destination_name" VARCHAR(255),
    "destination_id" INTEGER NOT NULL,
    "checkin_date" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "rooms" JSONB,
    "nationality_code" VARCHAR(10) NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3),
    "special_requirements" TEXT,
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "booking_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."proposals" (
    "id" UUID NOT NULL,
    "request_id" UUID,
    "status" VARCHAR(50) NOT NULL DEFAULT 'draft',
    "offer_items" JSONB,
    "total_buy" DECIMAL(12,2),
    "total_sell" DECIMAL(12,2),
    "markup_settings" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."proposal_hotels" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "hotel_code" VARCHAR(255) NOT NULL,
    "tid" VARCHAR(255) NOT NULL,
    "total_price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "free_cancellation" BOOLEAN,
    "cancel_deadline" TIMESTAMPTZ,
    "supplier_code" VARCHAR(50),
    "rooms" JSONB,
    "option_details_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_hotels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."proposal_services" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "service_name" VARCHAR(255),
    "date_from" DATE,
    "date_to" DATE,
    "buy_price" DECIMAL(12,2),
    "sell_price" DECIMAL(12,2),
    "quantity" INTEGER,
    "days" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache"."hotel_option_details" (
    "id" UUID NOT NULL,
    "tid" VARCHAR(255) NOT NULL,
    "hotel_code" VARCHAR(255),
    "data" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "non_refundable" BOOLEAN,
    "cxl_option_date" TIMESTAMP(3),
    "cxl_conditions" JSONB,
    "cxl_comment" TEXT,
    "cxl_remarks" JSONB,
    "dayprices_total" DECIMAL(12,2),
    "dayprices_currency" VARCHAR(10),
    "meal_type" VARCHAR(10),
    "meal_name" VARCHAR(255),
    "provider_price" DECIMAL(12,2),
    "provider_currency" VARCHAR(10),
    "supplier_code" VARCHAR(50),
    "essential_info" TEXT,
    "price_comment" TEXT,
    "supplements" JSONB,
    "optional_extras" JSONB,
    "special_offers" JSONB,
    "rooms" JSONB,
    "success" BOOLEAN,
    "version_description" VARCHAR(100),

    CONSTRAINT "hotel_option_details_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_name_key" ON "auth"."user_roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "auth"."users"("email");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "auth"."users"("role_id");

-- CreateIndex
CREATE INDEX "destinations_name_idx" ON "master"."destinations"("name");

-- CreateIndex
CREATE INDEX "destinations_parent_id_idx" ON "master"."destinations"("parent_id");

-- CreateIndex
CREATE INDEX "hotels_destination_id_idx" ON "master"."hotels"("destination_id");

-- CreateIndex
CREATE INDEX "hotels_supplier_code_idx" ON "master"."hotels"("supplier_code");

-- CreateIndex
CREATE INDEX "hotels_name_idx" ON "master"."hotels"("name");

-- CreateIndex
CREATE INDEX "facilities_name_idx" ON "master"."facilities"("name");

-- CreateIndex
CREATE INDEX "hotel_facilities_hotel_code_idx" ON "master"."hotel_facilities"("hotel_code");

-- CreateIndex
CREATE INDEX "hotel_facilities_facility_id_idx" ON "master"."hotel_facilities"("facility_id");

-- CreateIndex
CREATE INDEX "hotel_facilities_hotel_code_facility_id_idx" ON "master"."hotel_facilities"("hotel_code", "facility_id");

-- CreateIndex
CREATE INDEX "hotel_images_hotel_code_idx" ON "master"."hotel_images"("hotel_code");

-- CreateIndex
CREATE INDEX "hotel_images_hotel_code_display_order_idx" ON "master"."hotel_images"("hotel_code", "display_order");

-- CreateIndex
CREATE INDEX "hotel_facility_groups_hotel_code_idx" ON "master"."hotel_facility_groups"("hotel_code");

-- CreateIndex
CREATE INDEX "hotel_facility_groups_group_type_idx" ON "master"."hotel_facility_groups"("group_type");

-- CreateIndex
CREATE INDEX "booking_requests_destination_id_idx" ON "app"."booking_requests"("destination_id");

-- CreateIndex
CREATE INDEX "booking_requests_status_idx" ON "app"."booking_requests"("status");

-- CreateIndex
CREATE INDEX "booking_requests_nationality_code_idx" ON "app"."booking_requests"("nationality_code");

-- CreateIndex
CREATE INDEX "booking_requests_created_at_idx" ON "app"."booking_requests"("created_at");

-- CreateIndex
CREATE INDEX "proposals_request_id_idx" ON "app"."proposals"("request_id");

-- CreateIndex
CREATE INDEX "proposals_status_idx" ON "app"."proposals"("status");

-- CreateIndex
CREATE INDEX "proposal_hotels_proposal_id_idx" ON "app"."proposal_hotels"("proposal_id");

-- CreateIndex
CREATE INDEX "proposal_hotels_hotel_code_idx" ON "app"."proposal_hotels"("hotel_code");

-- CreateIndex
CREATE INDEX "proposal_hotels_tid_idx" ON "app"."proposal_hotels"("tid");

-- CreateIndex
CREATE INDEX "proposal_hotels_option_details_id_idx" ON "app"."proposal_hotels"("option_details_id");

-- CreateIndex
CREATE INDEX "proposal_services_proposal_id_idx" ON "app"."proposal_services"("proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "hotel_option_details_tid_key" ON "cache"."hotel_option_details"("tid");

-- CreateIndex
CREATE INDEX "hotel_option_details_hotel_code_idx" ON "cache"."hotel_option_details"("hotel_code");

-- CreateIndex
CREATE INDEX "hotel_option_details_fetched_at_idx" ON "cache"."hotel_option_details"("fetched_at");

-- CreateIndex
CREATE INDEX "hotel_option_details_expires_at_idx" ON "cache"."hotel_option_details"("expires_at");

-- CreateIndex
CREATE INDEX "hotel_option_details_dayprices_total_idx" ON "cache"."hotel_option_details"("dayprices_total");

-- AddForeignKey
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "auth"."user_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master"."destinations" ADD CONSTRAINT "destinations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "master"."destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."proposals" ADD CONSTRAINT "proposals_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "app"."booking_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."proposal_hotels" ADD CONSTRAINT "proposal_hotels_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "app"."proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."proposal_services" ADD CONSTRAINT "proposal_services_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "app"."proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
