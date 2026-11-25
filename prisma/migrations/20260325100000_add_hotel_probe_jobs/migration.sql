-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "app"."HotelProbeJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'PROBING', 'COMPLETED', 'SKIPPED_INSUFFICIENT', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "app"."hotel_probe_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "search_request_id" UUID NOT NULL,
    "hotel_code" VARCHAR(255) NOT NULL,
    "requested_rooms" INTEGER NOT NULL,
    "probe_limit" INTEGER NOT NULL,
    "rooms_found" INTEGER NOT NULL DEFAULT 0,
    "status" "app"."HotelProbeJobStatus" NOT NULL DEFAULT 'QUEUED',
    "last_probe_range" VARCHAR(20),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "result_json" JSONB,
    "options_snapshot" JSONB,
    "error_msg" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotel_probe_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE INDEX IF NOT EXISTS "hotel_probe_jobs_search_request_id_idx" ON "app"."hotel_probe_jobs"("search_request_id");
CREATE INDEX IF NOT EXISTS "hotel_probe_jobs_status_idx" ON "app"."hotel_probe_jobs"("status");
CREATE INDEX IF NOT EXISTS "hotel_probe_jobs_search_request_id_status_idx" ON "app"."hotel_probe_jobs"("search_request_id", "status");
