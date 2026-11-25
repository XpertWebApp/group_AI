-- AlterTable
ALTER TABLE "app"."hotel_probe_jobs" ADD COLUMN     "alternative_reason" VARCHAR(80),
ADD COLUMN     "search_kind" VARCHAR(20) NOT NULL DEFAULT 'main';
