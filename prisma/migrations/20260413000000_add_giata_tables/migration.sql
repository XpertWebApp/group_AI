-- Add GIATA sync tracking fields to hotels
ALTER TABLE "master"."hotels"
  ADD COLUMN IF NOT EXISTS "giata_synced_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "giata_status" VARCHAR(20);

-- GIATA MHG: Multilingual hotel text sections
CREATE TABLE IF NOT EXISTS "master"."hotel_giata_texts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hotel_code" VARCHAR(255) NOT NULL,
  "giata_id" VARCHAR(50) NOT NULL,
  "lang" VARCHAR(10) NOT NULL,
  "section_type" VARCHAR(20) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "content" TEXT NOT NULL,
  "last_update" TIMESTAMPTZ,
  "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "hotel_giata_texts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_giata_texts_hotel_code_lang_section_type_key"
  ON "master"."hotel_giata_texts" ("hotel_code", "lang", "section_type");
CREATE INDEX IF NOT EXISTS "hotel_giata_texts_hotel_code_idx"
  ON "master"."hotel_giata_texts" ("hotel_code");
CREATE INDEX IF NOT EXISTS "hotel_giata_texts_giata_id_idx"
  ON "master"."hotel_giata_texts" ("giata_id");

-- GIATA MHG: Structured fact sheet data
CREATE TABLE IF NOT EXISTS "master"."hotel_giata_facts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hotel_code" VARCHAR(255) NOT NULL,
  "giata_id" VARCHAR(50) NOT NULL,
  "section_type" VARCHAR(20) NOT NULL,
  "section_name" VARCHAR(100) NOT NULL,
  "fact_id" INTEGER NOT NULL,
  "fact_name" VARCHAR(100) NOT NULL,
  "type_hint" VARCHAR(20) NOT NULL,
  "value" VARCHAR(500) NOT NULL,
  "unit" VARCHAR(20),
  "fee" BOOLEAN DEFAULT false,
  "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "hotel_giata_facts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_giata_facts_hotel_code_fact_id_key"
  ON "master"."hotel_giata_facts" ("hotel_code", "fact_id");
CREATE INDEX IF NOT EXISTS "hotel_giata_facts_hotel_code_idx"
  ON "master"."hotel_giata_facts" ("hotel_code");
CREATE INDEX IF NOT EXISTS "hotel_giata_facts_section_type_idx"
  ON "master"."hotel_giata_facts" ("section_type");

-- GIATA MHG: Hotel image URLs
CREATE TABLE IF NOT EXISTS "master"."hotel_giata_images" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hotel_code" VARCHAR(255) NOT NULL,
  "giata_id" VARCHAR(50) NOT NULL,
  "image_type" VARCHAR(5) NOT NULL,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "url_small" TEXT,
  "url_medium" TEXT,
  "url_large" TEXT,
  "last_update" TIMESTAMPTZ,
  "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "hotel_giata_images_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "hotel_giata_images_hotel_code_idx"
  ON "master"."hotel_giata_images" ("hotel_code");
CREATE INDEX IF NOT EXISTS "hotel_giata_images_hotel_code_display_order_idx"
  ON "master"."hotel_giata_images" ("hotel_code", "display_order");

-- GIATA Multicodes: Supplier/GDS mapping codes
CREATE TABLE IF NOT EXISTS "master"."hotel_giata_mappings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hotel_code" VARCHAR(255) NOT NULL,
  "giata_id" VARCHAR(50) NOT NULL,
  "provider_code" VARCHAR(50) NOT NULL,
  "provider_type" VARCHAR(20) NOT NULL,
  "code_value" VARCHAR(255) NOT NULL,
  "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "hotel_giata_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_giata_mappings_hotel_code_provider_code_code_value_key"
  ON "master"."hotel_giata_mappings" ("hotel_code", "provider_code", "code_value");
CREATE INDEX IF NOT EXISTS "hotel_giata_mappings_hotel_code_idx"
  ON "master"."hotel_giata_mappings" ("hotel_code");
CREATE INDEX IF NOT EXISTS "hotel_giata_mappings_giata_id_idx"
  ON "master"."hotel_giata_mappings" ("giata_id");
CREATE INDEX IF NOT EXISTS "hotel_giata_mappings_provider_code_idx"
  ON "master"."hotel_giata_mappings" ("provider_code");
