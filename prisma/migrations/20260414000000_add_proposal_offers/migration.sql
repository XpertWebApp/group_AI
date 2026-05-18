-- Proposal offer history: each send to client creates one row
CREATE TABLE IF NOT EXISTS "app"."proposal_offers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "proposal_id" UUID NOT NULL,
  "offer_number" INTEGER NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "pdf_key" TEXT NOT NULL,
  "pdf_url" TEXT NOT NULL,
  "sent_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "sent_by" UUID NOT NULL,
  "sent_to_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "hotel_snapshot" JSONB,
  "service_snapshot" JSONB,
  "total_price" DECIMAL(12, 2),
  "currency" VARCHAR(10),
  "method" VARCHAR(20),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "proposal_offers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "proposal_offers_proposal_id_offer_number_key"
  ON "app"."proposal_offers" ("proposal_id", "offer_number");

CREATE INDEX IF NOT EXISTS "proposal_offers_proposal_id_idx"
  ON "app"."proposal_offers" ("proposal_id");

CREATE INDEX IF NOT EXISTS "proposal_offers_sent_at_idx"
  ON "app"."proposal_offers" ("sent_at");

ALTER TABLE "app"."proposal_offers"
  ADD CONSTRAINT "proposal_offers_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "app"."proposals"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
