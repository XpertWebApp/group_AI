-- Remove WRW_ILSX ("Illusions (XTG-WRW)") — it is NOT on the official WBE
-- Supplier list. This makes app.supplier_limits match the WBE PDF exactly (26
-- suppliers). If WBE ever returns a WRW_ILSX option, it falls back to the
-- default supplier cap, so removal causes no behavioural change.

DELETE FROM "app"."supplier_limits" WHERE "supplier_code" = 'WRW_ILSX';
