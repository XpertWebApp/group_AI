-- AlterTable
-- Odoo CRM link on booking_requests. Nullable so existing rows are
-- grandfathered; the offer-send gate is enforced by application logic
-- comparing created_at against ODOO_GATE_ACTIVE_SINCE.
ALTER TABLE "app"."booking_requests"
    ADD COLUMN "odoo_contact_id" INTEGER;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "booking_requests_odoo_contact_id_idx"
    ON "app"."booking_requests" ("odoo_contact_id");
