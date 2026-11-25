# WBE SmartKonnect XMLOUT — Certification Runner

Runs WBE's 14 certification scenarios and captures the booking reference each
one produces. Those references are the only artefact WBE's certification
document asks for.

## Before running with `--book`

`--book` creates **real reservations against the UAT credit line**. Three things
must be confirmed first:

| # | Required | From |
|---|---|---|
| 1 | UAT account has sufficient credit | WBE / client |
| 2 | Written approval for scenarios 13 & 14 (Nonrefundable — these cost money) | Client |
| 3 | Booking notification email address | Client |

Without (1) WBE returns no booking reference at all and certification cannot
complete. Without (2), leave scenarios 13 and 14 skipped — WBE's document asks
for "as many scenarios as possible", not all 14.

## Commands

```bash
# Dry run — search + option details + prebook. No reservations. Safe to repeat.
npm run cert:dry-run

# Subset
npm run cert:dry-run -- --scenarios 1,3,9

# LIVE — creates real bookings for the 12 refundable scenarios,
# then cancels each one after capturing its reference.
npm run cert:run

# LIVE including the two nonrefundable scenarios. Requires client approval:
# these cannot be cancelled without charge.
npm run cert:run -- --allow-nonrefundable

# Keep bookings open instead of auto-cancelling (they will be charged at deadline)
npm run cert:run -- --no-cancel

# Cancel any refundable test booking left open by an interrupted run
npm run cert:cleanup            # preview
npm run cert:cleanup -- --confirm
```

## What the runner does per scenario

1. Search each candidate destination until one returns options.
2. Re-read the option via `GetUpdatedOptions` when `UpdatedOptionsNeeded=true`.
3. Persist a draft booking (creates the AgencyReference).
4. `OptionDetailsV2` with `Prebook=true` — mandatory, once only.
5. Accept a price change if WBE returned a different price.
6. `BookV2` — only with `--book`.
7. Cancel the booking if refundable, after recording its reference.

An ambiguous `BookV2` failure is reconciled by AgencyReference rather than
retried, because a retry could create a second reservation.

## Why several destinations

`config.ts` lists five destinations, tried in order until one returns options.
WBE's own notes say scenarios may return nothing "due to the dynamic
availability of the configured test suppliers", and a search-only run against
Rome in May returned zero options for every scenario. Falling through the list
prevents a supplier's quiet day from being reported as a failure.

## Configuration

Everything an operator changes lives in [`config.ts`](./config.ts):

- `DESTINATION_CANDIDATES` — destinations to try, in order
- `CHECKIN_DAYS_AHEAD` — how far ahead to book (default 45 days)
- `CURRENCY_CODE` / `NATIONALITY_CODE`
- `AUTO_CANCEL_AFTER_BOOKING` — cancel refundable bookings after capturing refs
- `PASSENGER_LAST_NAME`, name pools

The scenario definitions in [`scenarios.ts`](./scenarios.ts) are transcribed from
WBE's PDF and should not need editing.

## Output

Written to `scripts/output/certification/`:

| File | Contents |
|---|---|
| `scenario-<n>.json` | Full result per scenario |
| `summary.json` | Machine-readable run summary |
| `summary.md` | Table ready to paste into WBE's document |

Booking references are also printed to the console at the end of a run.

## Verified so far

A full dry run (2026-08-04) against WBE UAT completed all 12 refundable
scenarios — search, option details and prebook — with zero failures. Both
nonrefundable scenarios were correctly skipped. `BookV2` has not yet been
exercised against WBE, as it requires the confirmations listed above.
