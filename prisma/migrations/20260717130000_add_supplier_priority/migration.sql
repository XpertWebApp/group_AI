-- Add priority column to app.supplier_limits, plus a matching enum type.
--
-- Client requirement (Oliver, 2026-07-XX):
--   HIGH   = "push"     — HyperGuest, Roibos (unlimited rooms, allocated first)
--   MEDIUM = "preferred" — Expedia PKG + SA, Sun Hotels, DOTW
--   LOW    = "careful"   — HotelBeds, GoGlobal, RoomsXML, ABR, TBO (max 5-6 rooms)
--   AVOID  = "avoid"     — TALE, Mideast (TBX), POW (last-resort only)
--
-- Notes:
--   * AVOID is different from groupsAllowed=false. AVOID suppliers are still
--     eligible when no higher-priority supplier can fulfil a hotel's rooms;
--     groupsAllowed=false blocks them entirely.
--   * New / unknown suppliers default to MEDIUM.

-- 1. Create the enum type in the app schema
CREATE TYPE "app"."SupplierPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'AVOID');

-- 2. Add the column with a MEDIUM default so no existing row is left NULL
ALTER TABLE "app"."supplier_limits"
    ADD COLUMN "priority" "app"."SupplierPriority" NOT NULL DEFAULT 'MEDIUM';

-- 3. Backfill Oliver's stated priorities.
--    HIGH — Oliver said "push" for these two.
UPDATE "app"."supplier_limits" SET "priority" = 'HIGH'
 WHERE "supplier_code" IN ('HPG', 'RBSX');

--    MEDIUM — Oliver said "preferred" for these. Expedia has two rows sharing
--    the code EANRP (PKG + SA); UPDATE hits both correctly.
UPDATE "app"."supplier_limits" SET "priority" = 'MEDIUM'
 WHERE "supplier_code" IN ('EANRP', 'SNH', 'DOTW');

--    LOW — Oliver said "careful (max 5 rooms)" for these. Priority is separate
--    from maxRooms — this migration only sets priority. Room limits stay at
--    whatever admin already configured; the FE can update them via the
--    Settings UI. NB: ABR + TBO are not yet in our supplier_limits table
--    (unknown to WBE integration so far). They'll get priority=MEDIUM by
--    default if/when admin adds them; that's fine — admin can demote later.
UPDATE "app"."supplier_limits" SET "priority" = 'LOW'
 WHERE "supplier_code" IN ('HBA', 'GG', 'RMXML');

--    AVOID — Oliver said "avoid" for these three.
UPDATE "app"."supplier_limits" SET "priority" = 'AVOID'
 WHERE "supplier_code" IN ('TLE_S', 'TBX_S', 'POW_S');

-- 4. Everyone else stays at MEDIUM (the column default).
