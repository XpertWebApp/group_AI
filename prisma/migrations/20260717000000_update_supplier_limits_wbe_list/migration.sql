-- Update Supplier Limits list to match the official WBE Supplier list.
-- Ref: backend handover "Update the Supplier Limits list to match the WBE Supplier list".
--
-- Adds 9 suppliers that were missing from the app, and corrects 2 provider names.
-- All new suppliers use the default limits (9 rooms / groups allowed) and remain
-- editable from Settings -> Supplier Limits.
--
-- Documented decisions:
--   * EANRP appears twice in the WBE PDF (Expedia "PKG Rates" + "SA Rates").
--     `supplier_code` is the unique PATCH key, so BOTH map to ONE row (EANRP).
--   * WRW_ILSX ("Illusions (XTG-WRW)") is NOT on the PDF but is KEPT — it is a
--     functioning supplier code; removing it would only make it an unknown
--     supplier that falls back to the default cap anyway (no functional gain).
--
-- Idempotent: ON CONFLICT DO NOTHING preserves any manual limit edits made in
-- the UI, so re-running never overwrites operator changes.

INSERT INTO "app"."supplier_limits"
  ("supplier_code", "provider_name", "acc_code", "max_rooms", "groups_allowed", "notes")
VALUES
  ('AIC (XTG)', 'AIC Travel Group',   NULL, 9, true, NULL),
  ('EANRP',     'Expedia Group',      NULL, 9, true, 'WBE lists PKG Rates + SA Rates; both use supplier code EANRP'),
  ('GTS (XTG)', 'GTS (XTG)',          NULL, 9, true, NULL),
  ('HTS 1',     'Hotelston 1',        NULL, 9, true, NULL),
  ('ILS3X',     'Illusions X3 (XTG)', NULL, 9, true, NULL),
  ('RBSX',      'Roibos (XTG)',       NULL, 9, true, NULL),
  ('SMYX',      'Smyrooms (XTC)',     NULL, 9, true, NULL),
  ('TBX_S',     'Mideast Travel',     NULL, 9, true, NULL),
  ('NBDX',      'Nordbeds',           NULL, 9, true, NULL)
ON CONFLICT ("supplier_code") DO NOTHING;

-- Provider-name corrections
UPDATE "app"."supplier_limits" SET "provider_name" = 'SETT Extranet' WHERE "supplier_code" = 'SETT';
UPDATE "app"."supplier_limits" SET "provider_name" = 'TALE TRAVEL'   WHERE "supplier_code" = 'TLE_S';
