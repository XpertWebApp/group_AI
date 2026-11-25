# UAT → LIVE cutover (local database)

**Purpose:** Prepare a local dev database for the LIVE WBE cutover.

- UAT static data is preserved (not deleted) by moving `master.*` tables into a new `uat_archive` schema.
- Fresh empty `master.*` tables are created with the exact structure Prisma expects.
- All UAT-era request/proposal/booking test data is truncated so LIVE flows start clean.
- The `booking_requests.reference_number` sequence is bumped to `100000` so future LIVE reference numbers never collide with any UAT number that may already be out there in an email, screenshot, or Odoo lead.
- A WBE client safety guard blocks real bookings while LIVE creds are pointed at a local DB.

**Scope:** LOCAL DATABASE ONLY. Do NOT run any of these SQL scripts against the production database. A separate cutover plan will cover production after Oliver confirms timing.

---

## Prerequisites

1. Local Postgres running with the current UAT-synced schema.
2. `DATABASE_URL` in `.env` pointing at the LOCAL DB.
3. **Full DB backup taken first.** Any of the destructive steps (script 03, or a rollback after LIVE sync) is only reversible from a backup.
   ```bash
   pg_dump "$DATABASE_URL_WITHOUT_PGBOUNCER_PARAM" > backups/local-pre-cutover-$(date +%Y%m%d-%H%M).sql
   ```
4. Server not running against this DB during the run (avoid connection contention).

`DATABASE_URL` note — Prisma uses `?pgbouncer=true&statement_cache_size=0` in the URL. `psql` does not understand `pgbouncer`; strip everything from the `?` onwards before feeding the URL to psql:

```bash
DB_URL=$(echo "$DATABASE_URL" | sed 's|?.*||')
```

---

## Files in this folder

| File | Purpose | Destructive? |
|---|---|---|
| `00-preflight-checks.sql` | Read-only sanity checks. Prints row counts before you start. | No |
| `01-archive-master-to-uat.sql` | Move 10 `master.*` static tables into `uat_archive.*`. | No (reversible via rollback) |
| `02-create-fresh-master-tables.sql` | Create empty `master.*` tables matching the Prisma schema. | No |
| `03-truncate-app-tables.sql` | Truncate all UAT request/proposal/booking rows. Bump reference_number sequence to 100000. | **YES** — cannot be undone without a backup |
| `rollback-restore-uat.sql` | Move `uat_archive.*` back into `master.*`. Guards against overwriting fresh LIVE data. | Yes if LIVE data present (protected by guard) |

---

## Execution order

Run in strict order. If any step fails, do NOT proceed until you understand why.

### Step 0 — Pre-flight

```bash
DB_URL=$(echo "$DATABASE_URL" | sed 's|?.*||')
psql "$DB_URL" -f scripts/uat-cutover/00-preflight-checks.sql
```

Verify:
- `master` schema has all 10 static tables with non-zero row counts.
- `uat_archive` schema does NOT exist yet.
- Never-touched tables (auth.users, app.settings, app.supplier_limits, audit.*) show real counts.

### Step 1 — Archive master tables to `uat_archive`

```bash
psql "$DB_URL" -f scripts/uat-cutover/01-archive-master-to-uat.sql
```

Guards inside the script:
- Aborts if `uat_archive` already contains any of the target tables.
- Aborts if the final table count in `uat_archive` isn't 10.

After success:
- `uat_archive.destinations`, `uat_archive.hotels`, … (10 tables) hold your UAT data.
- `master` schema is left with only the reference tables (`currencies`, `nationalities`, `languages`).

### Step 2 — Create fresh empty master tables

```bash
psql "$DB_URL" -f scripts/uat-cutover/02-create-fresh-master-tables.sql
```

Guards:
- Aborts if any of the fresh `master.*` tables already exist.

After success:
- `master.destinations`, `master.hotels`, … (10 tables) exist and are empty.
- Structure exactly matches what Prisma's schema declares (columns, types, indexes, PKs, unique constraints, FKs).
- Row count for every one of the 10 tables prints as 0.

### Step 3 — Truncate app request/booking tables

**Destructive. Take a backup first.**

```bash
psql "$DB_URL" -f scripts/uat-cutover/03-truncate-app-tables.sql
```

Guards:
- Refuses to run if `inet_server_addr()` is not `127.0.0.1` / `::1`. This blocks accidental execution against a remote DB.

After success:
- All rows removed from `app.booking_requests`, `app.proposals`, `app.bookings`, `app.notifications`, `app.hotel_probe_jobs`, `cache.hotel_option_details`, and all their child tables.
- `booking_requests.reference_number_seq` reset to start at `100000`.
- Never-touched tables (`auth.users`, `app.settings`, `app.supplier_limits`, `audit.*`) still populated — the script prints their counts as confirmation.

### Step 4 — Enable the WBE static-only safety guard

Before pointing LIVE creds at your local `.env`, add this line:

```bash
WBE_STATIC_ONLY_MODE=true
```

Then restart the server. On boot you'll see:

```
WBE client running in STATIC-ONLY mode — searches, bookings, vouchers and cancellations are blocked
```

While this env var is `true`:
- `bookV2`, `issueVoucher`, `cancelBookingV2` → throw immediately with a clear error.
- `optionDetailsV2` with `Prebook: true` → throw (that call reserves inventory on the WBE side, treated as a mutation).
- `optionDetailsV2` without `Prebook` → allowed (pure read).
- `searchAndGetByHotelsV2` → allowed (pure read from WBE's perspective — no ledger row created upstream).
- All static-data calls → allowed.

**Only unset `WBE_STATIC_ONLY_MODE` on the day the LIVE cutover is fully approved. Not before.**

### Step 5 — Run the LIVE static-data sync

Once the guard is on and the fresh empty `master.*` tables exist:

1. Point `.env` at the LIVE WBE creds (`WBE_USERNAME`, `WBE_PASSWORD`, `WBE_API_KEY`, `WBE_BASE_URL`, `WBE_SEARCH_URL`, `WBE_CONTENT_URL`).
2. Trigger the existing static-data sync (`staticData.service.ts` — same job that populated the UAT data originally).
3. Verify row counts in the fresh `master.*` tables afterwards.

---

## Rollback (emergency undo)

If you need to revert Steps 1 & 2 (**before** any LIVE data has been written into the fresh `master.*` tables):

```bash
psql "$DB_URL" -f scripts/uat-cutover/rollback-restore-uat.sql
```

Guards:
- Refuses to rollback if any fresh `master.*` table already contains rows. In that case the correct fix is to restore from the backup taken before Step 0.

**Rollback does NOT restore truncated app-table rows.** Those are only recoverable from a DB backup.

---

## Verification after full cutover

Run this checklist after Steps 1-5 complete:

- `psql "$DB_URL" -c "\dt uat_archive.*"` — 10 archive tables listed.
- `psql "$DB_URL" -c "\dt master.*"` — 13 tables (10 fresh + 3 reference).
- `psql "$DB_URL" -c "SELECT count(*) FROM master.hotels"` — non-zero (LIVE hotels synced).
- `psql "$DB_URL" -c "SELECT count(*) FROM app.booking_requests"` — 0 (clean slate).
- `psql "$DB_URL" -c "SELECT nextval('app.booking_requests_reference_number_seq')"` — returns a value ≥ 100000.
- Server logs on boot show `WBE client running in STATIC-ONLY mode`.
- Attempting a real booking through the API returns the `WBE_STATIC_ONLY_MODE is on — operation "bookV2" is blocked` error.

---

## What is NOT touched by any of these scripts

- `auth.users`, `auth.user_roles`
- `master.currencies`, `master.nationalities`, `master.languages`
- `app.settings`, `app.supplier_limits`
- `audit.audit_events`, `audit.sync_jobs`
- `prisma/schema.prisma` — not modified, so `prisma migrate` state stays in sync. The `uat_archive` schema is invisible to Prisma.
- Prisma migration history — no new migration file is added.

---

## For LIVE (production) database

**Separate plan. Not this folder.** These scripts are for LOCAL only. When Oliver confirms the LIVE cutover timing and account scope, a production-specific plan will be prepared (likely: staged in a maintenance window, with WBE-side coordination, DB snapshot immediately before, and progressive traffic ramp).
