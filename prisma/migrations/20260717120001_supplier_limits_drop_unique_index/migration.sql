-- The @unique on supplier_code created a UNIQUE INDEX (supplier_limits_supplier_code_key),
-- not a table constraint, so the earlier DROP CONSTRAINT was a no-op. Drop the unique
-- index here so duplicate supplier codes (e.g. two EANRP rows) are allowed. The separate
-- non-unique lookup index (supplier_limits_supplier_code_idx) is kept for search/matching.
DROP INDEX IF EXISTS "app"."supplier_limits_supplier_code_key";
