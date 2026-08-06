-- Move the selection token from the selection to the proposal.
--
-- The token is the credential in the link a customer follows to choose an
-- option. Holding it on option_selections made the link unusable: the row is
-- created by the act of choosing, so no token existed at the moment the link
-- had to be sent, and a customer opening it would be told their offer did not
-- exist.
--
-- On proposals it is issued when the offer goes out and stays stable, so a
-- customer returning to an older email still reaches their offer.
--
-- Safe to apply: option_selections is new in the previous migration and holds
-- no production rows, so dropping its token loses nothing.

-- AlterTable
ALTER TABLE "app"."proposals" ADD COLUMN "selection_token" VARCHAR(64);

-- CreateIndex
-- Unique: the token resolves to exactly one offer, and nullable so proposals
-- that have never been sent simply have none.
CREATE UNIQUE INDEX "proposals_selection_token_key"
    ON "app"."proposals"("selection_token");

-- AlterTable
DROP INDEX IF EXISTS "app"."option_selections_selection_token_key";
ALTER TABLE "app"."option_selections" DROP COLUMN IF EXISTS "selection_token";
