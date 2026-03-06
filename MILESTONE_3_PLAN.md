# Milestone 3 — AI Offer Generation Engine: Implementation Plan

**Date:** 2026-03-06
**Branch:** milestone_2 (continuing here)
**Prepared after reviewing:** SETT codebase, SearchAndGetByHotels tech doc, OptionDetailsV2 doc, SETT_Phase1_Hotel_Search_Guide, BookingFlow.png

---

## 1. Current State Audit

### Already Implemented (Do Not Rebuild)

| Area | File(s) | Status |
|---|---|---|
| WBE API client (POST endpoints) | `wbe.client.service.ts` | ✅ Done |
| Supplier limits table | `config/supplierLimits.ts` | ✅ Done |
| Hotel search orchestration (Steps 1–7) | `services/hotelSearch.service.ts` | ✅ Done (bugs below) |
| Hotel search repository (DB queries + cache) | `repositories/hotelSearch.repository.ts` | ✅ Done |
| Hotel search controller + routes | `controllers/hotelSearch.controller.ts`, `routes/requests.routes.ts` | ✅ Done |
| Offer generation pipeline (async) | `services/offerGeneration.service.ts` | ✅ Done (depends on fixes below) |
| Notification service (email + in-app) | `services/notification.service.ts` | ✅ Done |
| Notification repository + dashboard API | `repositories/notification.repository.ts` | ✅ Done |
| Webhook endpoint (Wix → SETT) | `services/webhook.service.ts`, `routes/webhook.routes.ts` | ✅ Done |
| Prisma schema (BookingRequest, Proposal, HotelOptionDetail, Notification) | `prisma/schema.prisma` | ✅ Done |

---

## 2. Bugs Found (Must Fix Before Everything Else Works)

These are confirmed issues found by comparing the WBE API documentation with the current implementation.

### Bug 1 — Search Response: Hotels in `Data[]`, not `Hotels[]`

**File:** `src/services/hotelSearch.service.ts` ~line 480
**Problem:** The WBE API returns hotels under the key `"Data"` (confirmed in the official tech doc sample response), but the code currently looks for `"Hotels"` / `"hotels"`:
```ts
// CURRENT — WRONG
const hotels = field<any[]>(result, 'Hotels', 'hotels') ?? [];
```
```ts
// FIX NEEDED
const hotels = field<any[]>(result, 'Data', 'Hotels', 'hotels', 'data') ?? [];
```
**Impact:** Without this fix, every hotel search returns zero results regardless of API status.

---

### Bug 2 — `ClxDeadline` field name mismatch

**File:** `src/services/hotelSearch.service.ts` ~line 284 in `parseWbeOptions`
**Problem:** The API response uses `"ClxDeadline"` (as documented in the tech doc sample), but the code only checks for `"CxlDeadline"` and `"cxlDeadline"`:
```ts
// CURRENT — missing the actual API field name
field<string>(opt, 'CancellationDeadline', 'cancellationDeadline', 'CxlDeadline', 'cxlDeadline')
```
```ts
// FIX NEEDED — add ClxDeadline
field<string>(opt, 'CancellationDeadline', 'cancellationDeadline', 'ClxDeadline', 'CxlDeadline', 'clxDeadline', 'cxlDeadline')
```
**Impact:** Free cancellation deadline is never captured, so `cancelDeadline` is always null in proposals.

---

### Bug 3 — OptionDetailsV2 response parsing: nested `CxlPolicy` / `DayPrices`

**File:** `src/services/hotelSearch.service.ts` in `parseOptionDetails` function
**Problem:** The actual OptionDetailsV2 response structure is:
```json
{
  "Data": {
    "CxlPolicy": {
      "OptionDate": "2025-10-26T19:59:59.000Z",
      "NonRefundable": false,
      "Conditions": [...]
    },
    "DayPrices": {
      "TotalPrice": 5521.24,
      "Currency": "EUR",
      "MealType": "BB",
      "EssentialInfo": "...",
      "Rooms": [...]
    }
  }
}
```
The current code does `const data = raw?.Data ?? raw?.data ?? raw` then tries to access `NonRefundable`, `OptionDate`, etc. directly on `data` — but these are nested under `data.CxlPolicy` and `data.DayPrices`.

**Impact:** All cancellation policy fields (nonRefundable, cxlDeadline, cxlConditions) and all pricing fields (mealType, daypricesTotal, rooms) are never populated in the cache.

---

### Bug 4 — `SupplierCode` not returned in SearchAndGetByHotelsV2 options

**File:** `src/services/hotelSearch.service.ts` in `parseWbeOptions`
**Problem:** The official WBE tech doc sample does **not** include a `SupplierCode` field in the option response. The current code attempts to extract it:
```ts
const supplierCode = field<string>(opt, 'SupplierCode', 'supplierCode', 'Supplier', 'supplier');
```
If no supplier code is in the response, all options get `undefined` as `supplierCode`, which means:
- `isGroupAllowed(undefined)` returns `true` (lenient default, OK)
- `getSupplierMaxRooms(undefined)` returns `9` (lenient default, OK)
- But supplier split and capacity filtering become meaningless

**Fix approach:** Keep the current lenient defaults (assume 9 max rooms if no supplier code). Accept that supplier-level filtering is best-effort until we can confirm from Oliver / actual API response if SupplierCode is included. Add a code comment documenting this uncertainty.

---

### Bug 5 — `UpdatedOptionsNeeded` per-option polling not handled

**File:** `src/services/hotelSearch.service.ts`
**Problem:** The WBE docs say each **option** can have `UpdatedOptionsNeeded: true` (per-option flag), meaning that specific option's data needs to be re-fetched. The current code only checks top-level `Finished: false` on the session response and polls the full session. It doesn't check per-option `UpdatedOptionsNeeded`.

**Impact:** Options that need updating are not re-fetched individually — they may show stale prices.

**Fix approach:** After collecting all options, filter out any with `UpdatedOptionsNeeded: true` and mark them in the result (don't exclude them entirely — just flag them for the UI). This is a lower priority fix.

---

### Bug 6 — `ai_generated` missing from `ListRequestsQuerySchema` status filter

**File:** `src/validation/requestSchemas.ts` ~line 116
**Problem:**
```ts
status: z.enum(['pending', 'draft', 'processing', 'completed', 'cancelled', ''])
```
The new `ai_generated` status is not included in the filter enum. Staff cannot filter the list by `ai_generated`.

---

## 3. Work Needed — Grouped by Priority

### Phase A: Critical Bug Fixes (makes the core flow actually work)

**A1. Fix `hotelSearch.service.ts` — Data vs Hotels field mapping**
- Fix hotel array field name: `Data` first, then fallback to `Hotels`
- Fix `ClxDeadline` field in parseWbeOptions
- Fix `parseOptionDetails` to correctly traverse `CxlPolicy` and `DayPrices` nested objects
- Add `UpdatedOptionsNeeded` per-option flag handling (mark flagged options, don't exclude)

**A2. Fix `requestSchemas.ts` — Add `ai_generated` to status filter**

---

### Phase B: Response Shape Alignment (makes frontend work correctly)

**B1. Align `hotelSearch.service.ts` search response with `FRONTEND_INTEGRATION.md`**

The frontend integration doc expects each hotel in the response to include a flat shape:
```json
{
  "hotelCode": "BDC-4782",
  "hotelName": "Hotel Arts Barcelona",
  "tid": "TID-abc123",
  "sessionId": "WBE-SESSION-xyz",
  "supplierCode": "HPG",
  "currency": "EUR",
  "buyingPrice": 28500,
  "freeCancellation": true,
  "cancelDeadline": "...",
  "status": "include"
}
```

The current response includes `usableOptions[]`, `selectedOptions[]`, `supplierSplit[]` etc. which is correct for internal use, but the frontend-facing response must also expose a clean summary field per hotel (best TID, best buying price, session ID, etc.) to allow the frontend to call option-details immediately.

**B2. Fix `OptionDetailsV2` response forwarded to frontend**

The frontend expects:
```json
{
  "tid": "...",
  "hotelCode": "...",
  "roomBreakdown": [{ "date": "...", "price": 250.00 }],
  "cancellationPolicy": { ... },
  "freeCancellation": true,
  "cancelDeadline": "..."
}
```

The current `fetchOptionDetails` return shape does not match. It needs to expose `roomBreakdown` (from `DayPrices.Rooms[].Prices[]`) and a clean `cancellationPolicy` object.

---

### Phase C: Offer Generation Polish

**C1. Review and harden `offerGeneration.service.ts`**
- After fixing search + option-details parsing (Phase A), re-verify the pipeline end-to-end
- Ensure status transitions work: `pending → processing → ai_generated` (currently jumps directly to `ai_generated`)
- Ensure proposal is created with correct pricing from option details (not just mid-range estimate)

**C2. Notification service wiring verification**
- Confirm `STAFF_NOTIFICATION_EMAIL` env var check works
- Test nodemailer graceful degradation when SMTP not configured (should log, not crash)
- In-app notifications: verify `app.notifications` table is created and queries work

---

### Phase D: Testing

**D1. Unit tests for field parsing functions**
- Test `parseWbeOptions` with real API response sample from the tech doc
- Test `parseOptionDetails` with real OptionDetailsV2 response sample from the doc

**D2. Integration test for hotel search flow**
- Mock WBE API (or use test credentials against UAT)
- Full flow: create request → hotel-search → option-details → create proposal → verify status

**D3. Update existing tests**
- `src/tests/proposals.test.ts` and `src/tests/validation.test.ts` — ensure they still pass after field changes

---

## 4. Files to Change (Summary)

| File | Change |
|---|---|
| `src/services/hotelSearch.service.ts` | Fix Bugs 1, 2, 3, 5 — field mappings, response parsing, UpdatedOptionsNeeded |
| `src/validation/requestSchemas.ts` | Fix Bug 6 — add `ai_generated` to status filter enum |
| `src/services/offerGeneration.service.ts` | Phase C — add `processing` status step, use option detail prices |
| `src/tests/proposals.test.ts` | Phase D — update mocks to match new field shapes |
| `src/tests/validation.test.ts` | Phase D — add test for ai_generated status filter |

**No new files** are required. Everything needed already exists.

---

## 5. Explicit Out-of-Scope (as instructed)

- Booking (BookV2) API — not in this milestone
- Voucher issuance — not in this milestone
- Cancellation API — not in this milestone
- PDF generation — noted as "pending" in FRONTEND_INTEGRATION.md, not in this milestone

---

## 6. Execution Order

```
1. Fix hotelSearch.service.ts (Bugs 1, 2, 3 — critical path)
2. Fix requestSchemas.ts (Bug 6 — trivial, 1 line)
3. Align response shapes (Phase B — required for frontend)
4. Harden offerGeneration.service.ts (Phase C)
5. Update/add tests (Phase D)
```

---

## 7. Questions Before Starting

1. **SupplierCode in search response (Bug 4):** Can you confirm whether the live WBE API returns a `SupplierCode` or `Channel` field in the SearchAndGetByHotelsV2 options? If not, supplier-level filtering will work only with lenient defaults (max 9 rooms per unknown supplier).

2. **UAT vs Production URL:** The `.env` has a WBE URL — is it pointing to UAT or production? The tech docs show different base URLs (`uat.b2b.wbeapi.com` vs production). The `wbe.client.service.ts` already has a 404 fallback to try both paths.

3. **`UpdatedOptionsNeeded` strategy (Bug 5):** Oliver's guide says to always search with 3 rooms and select mid-range. Should we simply discard options with `UpdatedOptionsNeeded: true` (simpler), or attempt per-option polling (more complete)?

---

**Awaiting your approval to proceed with Phase A (Bug Fixes) first.**
