-- Option selections: the customer choosing one hotel option from an offer.
--
-- This is the point the booking process begins. Until a row exists here an
-- offer is a quotation; once it does, SETT reserves rooms and takes on the
-- supplier's cancellation terms.
--
-- The accepted price and terms are stored on the row rather than read back from
-- the proposal, because the proposal can be amended afterwards and the customer
-- is held to what they were shown. For a non-refundable rate this record is
-- what stands behind SETT's financial exposure.
--
-- Additive only: creates one table. No existing table is altered and no data is
-- modified.

-- CreateTable
CREATE TABLE "app"."option_selections" (
    "id" UUID NOT NULL,
    "selection_token" VARCHAR(64) NOT NULL,
    "proposal_id" UUID NOT NULL,
    "offer_id" UUID,
    "hotel_code" VARCHAR(255) NOT NULL,
    "hotel_name" VARCHAR(255),
    "accepted_total" DECIMAL(12,2),
    "currency" VARCHAR(10),
    "non_refundable" BOOLEAN NOT NULL DEFAULT false,
    "accepted_terms" JSONB,
    "terms_accepted_at" TIMESTAMP(3),
    "accepted_from_ip" VARCHAR(64),
    "accepted_user_agent" TEXT,
    "selected_by_email" VARCHAR(255),
    "selected_by_id" UUID,
    "locked_until" TIMESTAMP(3),
    "selected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "option_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The token is the credential in the customer's selection link, so it has to
-- resolve to exactly one selection.
CREATE UNIQUE INDEX "option_selections_selection_token_key"
    ON "app"."option_selections"("selection_token");

CREATE INDEX "option_selections_proposal_id_idx" ON "app"."option_selections"("proposal_id");
CREATE INDEX "option_selections_offer_id_idx"    ON "app"."option_selections"("offer_id");
CREATE INDEX "option_selections_selected_at_idx" ON "app"."option_selections"("selected_at");

-- AddForeignKey
-- Cascade: a selection has no meaning without the proposal it chose from.
ALTER TABLE "app"."option_selections"
    ADD CONSTRAINT "option_selections_proposal_id_fkey"
    FOREIGN KEY ("proposal_id") REFERENCES "app"."proposals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: an offer may be superseded, but the customer's acceptance of what
-- they were shown survives it.
ALTER TABLE "app"."option_selections"
    ADD CONSTRAINT "option_selections_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "app"."proposal_offers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "app"."option_selections"
    ADD CONSTRAINT "option_selections_selected_by_id_fkey"
    FOREIGN KEY ("selected_by_id") REFERENCES "auth"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
