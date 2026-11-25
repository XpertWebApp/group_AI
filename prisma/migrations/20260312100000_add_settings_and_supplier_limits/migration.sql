-- CreateEnum
CREATE TYPE "app"."SettingCategory" AS ENUM ('general', 'email', 'company', 'policies');

-- CreateTable
CREATE TABLE "app"."settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category" "app"."SettingCategory" NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."supplier_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "supplier_code" VARCHAR(50) NOT NULL,
    "provider_name" VARCHAR(255) NOT NULL,
    "acc_code" VARCHAR(50),
    "max_rooms" INTEGER NOT NULL DEFAULT 9,
    "groups_allowed" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settings_category_idx" ON "app"."settings"("category");

-- CreateIndex
CREATE UNIQUE INDEX "settings_category_key_key" ON "app"."settings"("category", "key");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_limits_supplier_code_key" ON "app"."supplier_limits"("supplier_code");

-- CreateIndex
CREATE INDEX "supplier_limits_supplier_code_idx" ON "app"."supplier_limits"("supplier_code");

-- Seed: Default Settings
INSERT INTO "app"."settings" ("category", "key", "value") VALUES
  -- General Configuration
  ('general', 'defaultMarkupPercentage', '20'),

  -- Email Configuration
  ('email', 'smtpHost', ''),
  ('email', 'smtpPort', '587'),
  ('email', 'smtpUsername', ''),
  ('email', 'smtpPassword', ''),
  ('email', 'fromEmail', ''),
  ('email', 'fromName', ''),

  -- Company Details
  ('company', 'companyName', ''),
  ('company', 'assignedPerson', ''),
  ('company', 'emailAddress', ''),
  ('company', 'phoneNumber', ''),
  ('company', 'website', ''),
  ('company', 'taxId', ''),
  ('company', 'address', ''),

  -- Policies
  ('policies', 'termsConditionsEn', ''),
  ('policies', 'termsConditionsDe', ''),
  ('policies', 'cancellationConditionsEn', ''),
  ('policies', 'cancellationConditionsDe', '');

-- Seed: Supplier Limits (from existing supplierLimits.ts config)
INSERT INTO "app"."supplier_limits" ("supplier_code", "provider_name", "acc_code", "max_rooms", "groups_allowed", "notes") VALUES
  ('BMMX', 'BookMe Maldives (XTG)', 'PR-BMA-232', 9, true, NULL),
  ('DDT', 'Dida Travel', 'PR-DID-229', 9, true, NULL),
  ('DOTW', 'DOTW', 'PR-DOT-221', 9, true, NULL),
  ('GG', 'GoGlobal', 'PR-GG-222', 9, true, NULL),
  ('HBA', 'HotelBeds ApiTude', 'PR-HBA-223', 6, true, 'Problems above 6 rooms'),
  ('HTS', 'Hotelston', 'PR-HTS-224', 9, true, NULL),
  ('HPC', 'HP Coral', NULL, 9, true, NULL),
  ('HPG', 'HyperGuest', NULL, 0, true, 'No limit - unlimited'),
  ('WRW_ILSX', 'Illusions (XTG-WRW)', NULL, 9, true, NULL),
  ('ILSX', 'Illusions (XTG)', NULL, 9, true, NULL),
  ('MK7', 'Miki V7', NULL, 9, true, NULL),
  ('POW_S', 'POW_S', NULL, 0, false, 'Not for groups'),
  ('RS', 'Restel', NULL, 9, true, NULL),
  ('RMXML', 'RoomsXML', NULL, 7, true, 'Many problems'),
  ('SETT', 'Extranet', NULL, 9, true, 'Internal'),
  ('SNH', 'Sun Hotels', NULL, 9, true, NULL),
  ('TLE_S', 'TLE_S', NULL, 0, false, 'Not for groups'),
  ('YLG', 'Yalago', NULL, 9, true, NULL);
