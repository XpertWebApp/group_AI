-- CreateTable
CREATE TABLE "app"."failed_emails" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "recipient" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(500) NOT NULL,
    "body" TEXT NOT NULL,
    "reply_to" VARCHAR(255),
    "request_id" UUID,
    "proposal_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "failed_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "failed_emails_event_type_idx" ON "app"."failed_emails"("event_type");

-- CreateIndex
CREATE INDEX "failed_emails_request_id_idx" ON "app"."failed_emails"("request_id");

-- CreateIndex
CREATE INDEX "failed_emails_proposal_id_idx" ON "app"."failed_emails"("proposal_id");

-- CreateIndex
CREATE INDEX "failed_emails_resolved_at_idx" ON "app"."failed_emails"("resolved_at");
