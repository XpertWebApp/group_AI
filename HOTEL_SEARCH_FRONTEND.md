# Hotel Search — Frontend Integration Guide

> **Milestone 3 — AI Offer Generation Engine**
> Backend is fully implemented. This document describes every endpoint the frontend needs to call, the exact request/response shapes, and the recommended UI flow.

---

## Overview: The 4-Step Flow

```
1. Create Request       POST /api/v1/requests
        ↓
2. Hotel Search         POST /api/v1/requests/:id/hotel-search
        ↓
3. Option Details       POST /api/v1/requests/:id/hotel-search/option-details
        ↓
4. Calculate Price      POST /api/v1/requests/:id/hotel-search/calculate-price
        ↓
5. Create Proposal      POST /api/v1/requests/:requestId/proposals
```

All endpoints require `Authorization: Bearer <jwt>` header.

---

## Step 1 — Create Booking Request

### `POST /api/v1/requests`

Creates a new group booking request (the 4-step form). Returns `201` on success.

**Request body:**
```json
{
  "destinationId": 123,
  "destinationName": "Barcelona, Spain",
  "checkinDate": "2026-05-10",
  "checkoutDate": "2026-05-15",
  "nights": 5,
  "starRating": 4,
  "budgetRange": "€200-300/night",
  "groupType": "corporate",
  "groupSize": 30,
  "currencyCode": "EUR",
  "nationalityCode": "GB",
  "rooms": {
    "single": 5,
    "double": 10,
    "triple": 0,
    "quadruple": 0,
    "suites": 0
  },
  "breakfastPreference": "BB",
  "hotelLocation": "central",
  "specialRequirements": "Accessible rooms required",
  "companyName": "TechCorp Ltd",
  "firstName": "John",
  "lastName": "Doe",
  "contactEmail": "john@techcorp.com",
  "contactPhone": "+441234567890",
  "customerNotes": "Group prefers quiet floors",
  "termsAndConditions": "...",
  "cancellationConditions": "..."
}
```

**Notes:**
- Either `nights` or `checkoutDate` is required (not both required, but at least one).
- `breakfastPreference`: `"BB"` (breakfast included) or `"RO"` (room only).
- `hotelLocation`: `"central"` or `"outside_city_center"`.
- `rooms` fields all default to `0`.

**Response `201`:**
```json
{
  "success": true,
  "message": "Booking request created",
  "data": {
    "id": "uuid-of-the-request",
    "referenceNumber": 2458,
    "status": "pending",
    "companyName": "TechCorp Ltd",
    "destinationName": "Barcelona, Spain",
    ...
  }
}
```

**Save the `id` — you need it for all subsequent steps.**

---

## Step 2 — Hotel Search

### `POST /api/v1/requests/:id/hotel-search`

Triggers a full WBE search. Returns a list of hotels ranked by availability and price.

**Note:** This call can take **30–45 seconds**. Show a loading state with a progress indicator.

**Request body (all optional):**
```json
{
  "mealType": "BB",
  "includeAlternativeStars": true,
  "waitSeconds": 35,
  "currencyCode": "EUR",
  "nationalityCode": "GB"
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `mealType` | `"BB"` \| `"RO"` \| `"HB"` \| `"FB"` \| `"AI"` | (from request) | Filter by meal type |
| `includeAlternativeStars` | boolean | `true` | Also show ±1 star hotels |
| `waitSeconds` | 5–60 | `35` | WBE poll time — don't go below 30 for best results |
| `currencyCode` | string | from request | Override currency |
| `nationalityCode` | string | from request | Override nationality |

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "requestId": "uuid",
    "sessionId": "WBE-SESSION-ID",
    "finished": true,
    "totalRoomsRequested": 15,
    "summary": {
      "total": 42,
      "included": 28,
      "flagged": 9,
      "omitted": 5
    },
    "results": [ /* primary star-rating hotels — see HotelResult below */ ],
    "alternativeResults": [ /* ±1 star hotels, same shape */ ]
  }
}
```

### `HotelResult` shape

```json
{
  "hotelCode": "BDC-4782",
  "hotelName": "Hotel Arts Barcelona",
  "starRating": 5,
  "imageUrl": "https://cdn.wbe.travel/hotels/BDC-4782.jpg",
  "address": "Carrer de la Marina 19",
  "addressCity": "Barcelona",
  "addressCountry": "ES",
  "sessionId": "WBE-SESSION-ID",
  "status": "include",
  "totalAvailableRooms": 45,
  "highestMidRangePrice": 187.50,
  "currency": "EUR",
  "bestOption": {
    "tid": "TID-ABC123",
    "sessionId": "WBE-SESSION-ID",
    "supplierCode": "EANRP",
    "buyingPricePerRoomPerNight": 187.50,
    "currency": "EUR",
    "freeCancellation": true,
    "cancelDeadline": "2026-05-05T00:00:00.000Z",
    "mealType": "BB",
    "mealName": "Breakfast included",
    "roomDescriptions": ["Deluxe Double Sea View"]
  },
  "usableOptions": [ /* all filtered options — see ProcessedOption */ ],
  "selectedOptions": [ /* mid-range band options */ ],
  "supplierSplit": [ /* INTERNAL ONLY — do not show to customer */ ],
  "note": null
}
```

### Hotel `status` values

| Status | Meaning | UI treatment |
|--------|---------|-------------|
| `"include"` | Can fulfil the full room count | Show normally |
| `"flag"` | Risky — inventory may overlap | Show with warning badge |
| `"omit"` | Cannot fulfil group size | Hide or show greyed out |

### `bestOption` — most important field for the UI

`bestOption` is the **cheapest mid-range option** pre-selected for each hotel. Use this to:
- Display the price card (`buyingPricePerRoomPerNight` — this is the **buying price**, not what the customer sees)
- Call option-details (`tid` + `sessionId`)
- Show meal type, room description, cancellation deadline

> **Important:** `buyingPricePerRoomPerNight` is your cost price. Always apply markup before showing to the customer. Use Step 4 (calculate-price) for the sell price.

### `supplierSplit` — NEVER show to customer

```json
[
  { "supplierCode": "EANRP", "tid": "TID-ABC123", "rooms": 9, "pricePerRoomPerNight": 187.50, "currency": "EUR" },
  { "supplierCode": "HBA",   "tid": "TID-DEF456", "rooms": 6, "pricePerRoomPerNight": 195.00, "currency": "EUR" }
]
```

This is the internal supplier booking plan. It is for the SETT agent only, never exposed to the customer.

---

## Step 3 — Option Details

### `POST /api/v1/requests/:id/hotel-search/option-details`

Fetches exact per-night pricing and cancellation policy for selected hotels. Results are cached for 2 hours.

**Request body:**
```json
{
  "selections": [
    {
      "sessionId": "WBE-SESSION-ID",
      "tid": "TID-ABC123",
      "hotelCode": "BDC-4782"
    },
    {
      "sessionId": "WBE-SESSION-ID",
      "tid": "TID-DEF456",
      "hotelCode": "BDC-5901"
    }
  ]
}
```

- Max 20 selections per call.
- Get `sessionId`, `tid`, and `hotelCode` from `bestOption` in the hotel search result.

**Response `200`:**
```json
{
  "success": true,
  "data": [
    {
      "tid": "TID-ABC123",
      "hotelCode": "BDC-4782",
      "cached": false,
      "parsed": {
        "nonRefundable": false,
        "cxlDeadline": "2026-05-05T00:00:00.000Z",
        "mealType": "BB",
        "mealName": "Breakfast included",
        "daypricesTotal": 14062.50,
        "daypricesCurrency": "EUR",
        "providerPrice": 12500.00,
        "essentialInfo": "Check-in from 15:00. Photo ID required.",
        "roomBreakdown": [
          {
            "roomId": 1,
            "description": "Deluxe Double Sea View",
            "prices": [
              { "date": "2026-05-10", "price": 250.00 },
              { "date": "2026-05-11", "price": 250.00 },
              { "date": "2026-05-12", "price": 300.00 },
              { "date": "2026-05-13", "price": 300.00 },
              { "date": "2026-05-14", "price": 350.00 }
            ]
          }
        ],
        "cancellationPolicy": {
          "nonRefundable": false,
          "deadline": "2026-05-05T00:00:00.000Z",
          "conditions": [
            {
              "fromDate": "2026-05-05",
              "toDate": "2026-05-10",
              "amount": 500.00,
              "currency": "EUR",
              "text": "One night penalty if cancelled after 5 May"
            }
          ],
          "comment": "Free cancellation until 5 May 2026"
        },
        "supplements": []
      },
      "data": { /* full raw WBE response for debugging */ }
    }
  ]
}
```

### Key fields to display

| Field | Where to show |
|-------|--------------|
| `parsed.cxlDeadline` | "Free cancellation until {date}" badge |
| `parsed.cancellationPolicy` | Cancellation policy modal/tooltip |
| `parsed.mealName` | Meal plan label |
| `parsed.daypricesTotal` | Total buying cost (before markup) |
| `parsed.roomBreakdown` | Per-night price breakdown table |
| `parsed.essentialInfo` | Hotel notes / important information section |

---

## Step 4 — Calculate Customer Price

### `POST /api/v1/requests/:id/hotel-search/calculate-price`

Calculates the recommended customer sell price using markup + price psychology.

**Request body:**
```json
{
  "buyingPrice": 187.50,
  "markupPercent": 18
}
```

- `buyingPrice`: per room per night buying price (from `bestOption.buyingPricePerRoomPerNight` or `daypricesTotal / (rooms × nights)`)
- `markupPercent`: defaults to `18` if omitted. Valid range: 0–100.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "buyingPrice": 187.50,
    "sellPrice": 221,
    "markupPercent": 18
  }
}
```

**Price psychology applied automatically:**
- Round numbers ending in `0` → subtract 2 (€200 → €198)
- Numbers ending in `5` → subtract 1 (€195 → €194)

> **This is the price to show the customer.** The `sellPrice` is per room per night. Multiply by rooms × nights for the total.

---

## Step 5 — Create Proposal

### `POST /api/v1/requests/:requestId/proposals`

Creates a proposal attached to the booking request.

**Request body:**
```json
{
  "notes": "Auto-generated offer based on your requirements",
  "markupSettings": {
    "globalMarkupPercent": 18
  }
}
```

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "id": "proposal-uuid",
    "requestId": "request-uuid",
    "status": "draft",
    ...
  }
}
```

**Save the proposal `id` to add hotels to it.**

---

## Step 6 — Add Hotels to Proposal

### `POST /api/v1/proposals/:id/hotels`

Adds a selected hotel to the proposal.

**Request body:**
```json
{
  "hotelCode": "BDC-4782",
  "tid": "TID-ABC123",
  "currency": "EUR",
  "totalPrice": 33150,
  "freeCancellation": true,
  "cancelDeadline": "2026-05-05T00:00:00.000Z",
  "supplierCode": "EANRP",
  "rooms": {
    "Deluxe Double Sea View": {
      "net": 187.50,
      "sell": 221,
      "qty": 15,
      "nights": 5
    }
  }
}
```

---

## Supporting Endpoints

### List Requests (Group Requests page)

`GET /api/v1/requests`

**Query params:**
```
?page=1&limit=20&search=TechCorp&status=ai_generated&dateFrom=2026-01-01&dateTo=2026-12-31&sortBy=createdAt&sortOrder=desc
```

| Param | Values |
|-------|--------|
| `status` | `pending` \| `draft` \| `processing` \| `ai_generated` \| `completed` \| `cancelled` |
| `sortBy` | `createdAt` \| `checkinDate` \| `referenceNumber` |
| `sortOrder` | `asc` \| `desc` |

---

### Notifications (Staff Dashboard)

**List notifications:**
`GET /api/v1/dashboard/notifications?unread=true&limit=20`

**Mark one read:**
`PATCH /api/v1/dashboard/notifications/:id/read`

**Mark all read:**
`POST /api/v1/dashboard/notifications/read-all`

**Notification shape:**
```json
{
  "id": "uuid",
  "type": "new_offer_ready",
  "title": "New offer ready — #2458",
  "message": "AI offer for John Doe (Barcelona, Spain) is ready for review.",
  "entityId": "request-uuid",
  "entityType": "booking_request",
  "read": false,
  "createdAt": "2026-03-06T10:00:00.000Z"
}
```

---

### Dashboard Stats

`GET /api/v1/dashboard/stats`

```json
{
  "success": true,
  "data": {
    "totalRequests": 142,
    "pendingRequests": 8,
    "completedThisMonth": 34,
    "revenueThisMonth": 284000
  }
}
```

`GET /api/v1/dashboard/recent-offers`

Returns the most recent proposals with their request info.

---

## Booking Request Status Flow

```
webhook / form submit
        ↓
    pending          ← created, waiting for processing
        ↓
   processing        ← offer generation pipeline started
        ↓
  ai_generated       ← offer ready, agent should review
        ↓
   completed         ← agent sent offer to customer
```

Show status badges:
| Status | Badge color | Label |
|--------|------------|-------|
| `pending` | grey | Pending |
| `processing` | blue | Processing... |
| `ai_generated` | green | Offer Ready |
| `draft` | yellow | Draft |
| `completed` | green | Completed |
| `cancelled` | red | Cancelled |

---

## Recommended UI Flow (Hotel Search Screen)

```
1. Agent opens a request → clicks "Search Hotels"
2. Frontend calls POST /hotel-search with mealType from request (loading spinner)
3. Response arrives → show hotel grid
   - Left panel: results[] (primary star rating hotels)
   - Right panel: alternativeResults[] (±1 star hotels, collapsed by default)
   - Each card shows: hotelName, stars, image, mealName, cancelDeadline, buyingPricePerRoomPerNight
   - Status badge: ✓ Available / ⚠ Risky / ✗ Limited
4. Agent selects 1–5 hotels → clicks "Get Pricing Details"
5. Frontend calls POST /hotel-search/option-details with selected TIDs
6. Show expanded pricing panel: per-night breakdown, cancellation policy, essential info
7. Agent adjusts markup % (default 18%) → calls POST /calculate-price
8. Shows customer sell price
9. Agent clicks "Create Offer" → POST /proposals, then POST /proposals/:id/hotels for each hotel
10. Status updates to ai_generated → notification sent to staff
```

---

## Error Responses

All errors follow the same shape:

```json
{
  "success": false,
  "error": {
    "code": "validation_error",
    "message": "contactEmail: Invalid email"
  }
}
```

| HTTP | `code` | When |
|------|--------|------|
| 400 | `validation_error` | Invalid request body |
| 401 | `unauthorized` | Missing or invalid JWT |
| 404 | `NOT_FOUND` | Request/proposal not found |
| 429 | `rate_limited` | Too many requests (search: 10/min, create: 50/15min) |
| 500 | `internal_error` | Unexpected server error |

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `POST /requests` | 50 per 15 minutes |
| `POST /hotel-search` | 10 per minute |
| All others | No hard limit (standard auth) |
