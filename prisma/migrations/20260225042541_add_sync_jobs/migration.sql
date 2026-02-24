-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateEnum
CREATE TYPE "audit"."JobStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "audit"."sync_jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" "audit"."JobStatus" NOT NULL,
    "totalRecords" INTEGER,
    "processedRecords" INTEGER NOT NULL DEFAULT 0,
    "lastProcessedKey" TEXT,
    "errorMessage" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);
