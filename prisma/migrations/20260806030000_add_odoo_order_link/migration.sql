-- Link a booking group to its Odoo sales order.
--
-- The order is raised when the customer selects an option, but its reference
-- was only ever returned in the booking response — nothing recorded which order
-- a group belonged to. That leaves no way back to the commercial record once
-- the response is gone: not for a later stage update, not for a support query,
-- not for reconciliation.
--
-- Additive only: four nullable columns. Groups booked before this migration
-- simply have no order recorded, which is accurate — the link was never
-- captured for them.

-- AlterTable
ALTER TABLE "app"."booking_groups"
    ADD COLUMN "odoo_order_id"   INTEGER,
    ADD COLUMN "odoo_order_name" VARCHAR(64),
    ADD COLUMN "odoo_stage"      VARCHAR(64),
    ADD COLUMN "odoo_synced_at"  TIMESTAMP(3);

-- CreateIndex
-- Support queries start from the order number staff quote to each other, so
-- that is the lookup worth indexing.
CREATE INDEX "booking_groups_odoo_order_id_idx" ON "app"."booking_groups"("odoo_order_id");
