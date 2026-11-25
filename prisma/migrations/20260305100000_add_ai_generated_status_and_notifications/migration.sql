-- Add ai_generated to BookingRequestStatus enum
ALTER TYPE "app"."BookingRequestStatus" ADD VALUE IF NOT EXISTS 'ai_generated';

-- Create notifications table
CREATE TABLE IF NOT EXISTS "app"."notifications" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "type"        VARCHAR(100) NOT NULL,
    "title"       VARCHAR(255) NOT NULL,
    "message"     TEXT        NOT NULL,
    "entity_id"   UUID,
    "entity_type" VARCHAR(100),
    "read"        BOOLEAN     NOT NULL DEFAULT false,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notifications_entity_id_idx" ON "app"."notifications"("entity_id");
CREATE INDEX IF NOT EXISTS "notifications_read_created_idx" ON "app"."notifications"("read", "created_at");
