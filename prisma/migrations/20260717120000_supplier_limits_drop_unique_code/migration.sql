-- Supplier codes are no longer unique: some suppliers share a code but are
-- different rate plans (e.g. Expedia PKG Rates + SA Rates both use EANRP).
-- Rows are now identified by their primary-key `id`. Keep the non-unique
-- lookup index (supplier_limits_supplier_code_idx) for search/matching.
ALTER TABLE "app"."supplier_limits" DROP CONSTRAINT IF EXISTS "supplier_limits_supplier_code_key";
