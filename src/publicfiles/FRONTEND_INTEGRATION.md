# SETT Backend — Frontend Integration Reference

## Base URL

```
http://localhost:3000/api/v1
```

---

## Global Response Envelope

Every response (success or error) follows this shape:

```json
{
  "success": true,
  "data": { ... },
  "message": "Human-readable message"
}
```

On error:

```json
{
  "success": false,
  "data": null,
  "message": "Something went wrong",
  "error": "ERROR_CODE"
}
```

---

## Authentication

### Login

```
POST /auth/login
```

**Body:**

```json
{
  "email": "admin@sett.com",
  "password": "your-password"
}
```

**Response `data`:**

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": {
    "id": "uuid",
    "email": "admin@sett.com",
    "role": "admin"
  }
}
```

---

### Refresh Token

```
POST /auth/refresh
```

**Body:**

```json
{ "refreshToken": "eyJ..." }
```

**Response `data`:** same shape as login.

---

### Logout

```
POST /auth/logout
Authorization: Bearer <accessToken>
```

**Response `data`:** `null`

---

### Using the Token

Include the access token on every protected request:

```
Authorization: Bearer <accessToken>
```

When you get a `401` response, call `/auth/refresh` and retry. If refresh also fails, redirect to login.

---

## Booking Requests

### Create Request (4-step form)

```
POST /requests
Authorization: Bearer <token>
Content-Type: application/json
```

**Body** (all 4 steps merged into one payload):

```json
{
  // Step 1 - Trip Details (required)
  "destinationId": 123,
  "destinationName": "Barcelona, Spain",
  "checkinDate": "2026-06-10",
  "checkoutDate": "2026-06-15",   // OR provide "nights" below
  "nights": 5,                    // optional if checkoutDate given; derived automatically
  "starRating": 4,                // 1-5, optional
  "budgetRange": "mid",           // optional free text
  "budget": 5000,                 // optional number
  "groupType": "corporate",       // optional
  "groupSize": 30,                // optional int
  "currencyCode": "EUR",
  "nationalityCode": "GB",

  // Step 2 - Room & Accommodations
  "rooms": {
    "single": 0,
    "double": 10,
    "twin": 5,
    "triple": 0,
    "quadruple": 0,
    "suites": 0,
    "extraRoomsNote": "2 accessible rooms required"
  },
  "breakfastPreference": "BB",          // "BB" | "RO"
  "hotelLocation": "central",           // "central" | "outside_city_center"
  "specialRequirements": "Wheelchair accessible rooms needed",

  // Step 3 - Customer Details (required)
  "companyName": "TechCorp Ltd",
  "firstName": "John",
  "lastName": "Doe",
  "contactEmail": "john.doe@techcorp.com",
  "contactPhone": "+441234567890",
  "guestListFileKey": "uploads/guestlist-abc123.xlsx",  // optional
  "customerNotes": "VIP group, needs priority check-in",

  // Step 4 - Policies (optional)
  "termsAndConditions": "Standard T&C text...",
  "cancellationConditions": "Free cancellation until 30 days prior"
}
```

**Validation rules:**
- `destinationId`, `destinationName`, `checkinDate`, `companyName`, `firstName`, `lastName`, `contactEmail`, `contactPhone` are **required**
- Must provide either `checkoutDate` OR `nights` (checkout must be after checkin)
- `contactEmail` must be a valid email
- `contactPhone` minimum 5 characters
- `breakfastPreference`: only `"BB"` or `"RO"`
- `hotelLocation`: only `"central"` or `"outside_city_center"`

**Response `data`:**

```json
{
  "id": "uuid",
  "referenceNumber": 2458,
  "status": "pending",
  "companyName": "TechCorp Ltd",
  "firstName": "John",
  "lastName": "Doe",
  "contactName": "John Doe",
  "contactEmail": "john.doe@techcorp.com",
  "contactPhone": "+441234567890",
  "destinationId": 123,
  "destinationName": "Barcelona, Spain",
  "checkinDate": "2026-06-10T00:00:00.000Z",
  "checkoutDate": "2026-06-15T00:00:00.000Z",
  "nights": 5,
  "rooms": { "double": 10, "twin": 5 },
  "currencyCode": "EUR",
  "createdAt": "2026-03-05T12:00:00.000Z",
  "updatedAt": "2026-03-05T12:00:00.000Z"
}
```

---

### List Requests (paginated)

```
GET /requests?page=1&limit=20&search=techcorp&status=pending
Authorization: Bearer <token>
```

**Query parameters:**

| Param       | Type   | Default    | Notes                                                   |
|-------------|--------|------------|---------------------------------------------------------|
| `page`      | int    | 1          |                                                         |
| `limit`     | int    | 20         | max 100                                                 |
| `search`    | string | —          | Searches: companyName, destinationName, email, firstName, lastName, #referenceNumber |
| `status`    | string | —          | `pending` \| `draft` \| `processing` \| `completed` \| `cancelled` |
| `dateFrom`  | date   | —          | ISO date string, filters by createdAt                  |
| `dateTo`    | date   | —          | ISO date string                                        |
| `sortBy`    | string | createdAt  | `createdAt` \| `checkinDate` \| `referenceNumber`      |
| `sortOrder` | string | desc       | `asc` \| `desc`                                        |

**Response `data`:**

```json
{
  "data": [
    {
      "id": "uuid",
      "referenceNumber": 2458,
      "companyName": "TechCorp Ltd",
      "firstName": "John",
      "lastName": "Doe",
      "destinationName": "Barcelona, Spain",
      "checkinDate": "2026-06-10T00:00:00.000Z",
      "nights": 5,
      "status": "pending",
      "currencyCode": "EUR",
      "createdAt": "2026-03-05T12:00:00.000Z",
      "proposals": [
        { "id": "uuid", "status": "draft", "totalSell": "45000.00" }
      ]
    }
  ],
  "meta": {
    "total": 142,
    "page": 1,
    "limit": 20,
    "totalPages": 8
  }
}
```

---

### Get Request (full detail)

```
GET /requests/:id
Authorization: Bearer <token>
```

Returns the full request object with all fields.

---

### Get Request Summary

```
GET /requests/:id/summary
Authorization: Bearer <token>
```

Returns a lighter summary shape.

---

### Update Request

```
PATCH /requests/:id
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:** Same fields as create, all optional. Only send what changed.

---

## Hotel Search Flow

This is the core search pipeline. Call these after creating a request.

### Step 1 — Trigger Search

```
POST /requests/:id/hotel-search
Authorization: Bearer <token>
Content-Type: application/json
```

**Body (all optional):**

```json
{
  "mealType": "BB",                   // "BB" | "RO" | "HB" | "FB" | "AI"
  "includeAlternativeStars": true,    // also search ±1 star. Default: true
  "waitSeconds": 35,                  // WBE polling timeout. Default: 35, max: 60
  "currencyCode": "EUR",
  "nationalityCode": "GB"
}
```

**Response `data`:** Array of hotel options ranked by mid-range price:

```json
[
  {
    "hotelCode": "BDC-4782",
    "hotelName": "Hotel Arts Barcelona",
    "starRating": 5,
    "tid": "TID-abc123",
    "sessionId": "WBE-SESSION-xyz",
    "supplierCode": "HPG",
    "currency": "EUR",
    "buyingPrice": 28500,
    "rooms": {
      "double": { "net": 250, "sell": 310, "qty": 3, "nights": 5 }
    },
    "freeCancellation": true,
    "cancelDeadline": "2026-06-01T00:00:00.000Z",
    "status": "include"          // "include" | "flag" | "omit"
  }
]
```

**Note:** The search always uses 3 rooms (Oliver's rule), mid-range pricing, free cancellation filter. Results with `status: "omit"` don't have enough supplier capacity for the group size.

---

### Step 2 — Get Option Details

After user selects hotels they want to quote, call this to get per-night pricing and cancellation policy:

```
POST /requests/:id/hotel-search/option-details
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "selections": [
    {
      "sessionId": "WBE-SESSION-xyz",
      "tid": "TID-abc123",
      "hotelCode": "BDC-4782"
    }
  ]
}
```

Max 20 selections per call. Results are cached (2hr TTL).

**Response `data`:**

```json
[
  {
    "tid": "TID-abc123",
    "hotelCode": "BDC-4782",
    "optionDetailsId": "uuid",
    "roomBreakdown": [
      { "date": "2026-06-10", "price": 250.00 }
    ],
    "cancellationPolicy": { ... },
    "freeCancellation": true,
    "cancelDeadline": "2026-06-01T00:00:00.000Z"
  }
]
```

---

### Step 3 — Calculate Sell Price

```
POST /requests/:id/hotel-search/calculate-price
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "buyingPrice": 28500,
  "markupPercent": 15      // optional, defaults to system setting
}
```

**Response `data`:**

```json
{
  "buyingPrice": 28500,
  "markupPercent": 15,
  "sellPrice": 32775,
  "recommendedSellPrice": 32748    // price psychology applied (avoids round numbers)
}
```

---

## Proposals

### Create Proposal for a Request

```
POST /requests/:requestId/proposals
Authorization: Bearer <token>
Content-Type: application/json
```

**Body (all optional):**

```json
{
  "notes": "This is our best offer for the group",
  "markupSettings": { "globalMarkupPercent": 15 }
}
```

**Response `data`:** Full proposal object including `id`.

---

### List All Proposals

```
GET /proposals
Authorization: Bearer <token>
```

---

### Get Proposal

```
GET /proposals/:id
Authorization: Bearer <token>
```

**Response `data`:** Proposal with hotels, services, totals.

---

### Update Proposal Metadata

```
PATCH /proposals/:id
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "notes": "Updated notes",
  "markupSettings": { "globalMarkupPercent": 18 }
}
```

---

### Add Hotel to Proposal

```
POST /proposals/:id/hotels
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "hotelCode": "BDC-4782",
  "tid": "TID-abc123",             // optional, links to search result
  "optionDetailsId": "uuid",       // optional, links to cached detail
  "currency": "EUR",
  "totalPrice": 32748,
  "freeCancellation": true,
  "cancelDeadline": "2026-06-01",
  "supplierCode": "HPG",
  "rooms": {
    "double": { "net": 250, "sell": 310, "qty": 10, "nights": 5 },
    "twin":   { "net": 220, "sell": 280, "qty": 5,  "nights": 5 }
  }
}
```

---

### List Hotels on Proposal

```
GET /proposals/:id/hotels
Authorization: Bearer <token>
```

---

### Adjust Hotel Pricing

```
POST /proposals/:id/hotels/:hotelId/adjust-pricing
Authorization: Bearer <token>
Content-Type: application/json
```

**Body (all optional):**

```json
{
  "totalPrice": 31998,
  "currency": "EUR",
  "rooms": {
    "double": { "sell": 308 }
  }
}
```

---

### Remove Hotel from Proposal

```
DELETE /proposals/:id/hotels/:hotelId
Authorization: Bearer <token>
```

---

### Add Service to Proposal

```
POST /proposals/:id/services
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**

```json
{
  "serviceName": "Airport Transfer",
  "dateFrom": "2026-06-10",
  "dateTo": "2026-06-10",
  "buyPrice": 800,
  "sellPrice": 1000,
  "quantity": 2,
  "days": 1,
  "notes": "Return transfer x2 coaches"
}
```

Required: `serviceName` only. Everything else is optional.

---

### Lock Proposal (prevent concurrent edits)

```
POST /proposals/:id/actions/lock
Authorization: Bearer <token>
```

Lock expires after 15 minutes automatically.

**409 Conflict if already locked by another user:**

```json
{
  "error": {
    "code": "PROPOSAL_LOCKED",
    "message": "Proposal is locked by another user",
    "owner": { "id": "uuid", "name": "Jane Smith" }
  }
}
```

---

### Unlock Proposal

```
POST /proposals/:id/actions/unlock
Authorization: Bearer <token>
```

---

### Save as Draft

```
POST /proposals/:id/actions/save-draft
Authorization: Bearer <token>
```

Sets proposal status to `draft`.

---

### Send Proposal

```
POST /proposals/:id/actions/send
Authorization: Bearer <token>
Content-Type: application/json
```

**Body (optional):**

```json
{ "sendToEmail": "client@techcorp.com" }
```

If `sendToEmail` is omitted, sends to the request's `contactEmail`. Sets status to `sent`.

**409 Conflict** if locked by another user (same shape as lock endpoint).

---

### Preview PDF

```
POST /proposals/:id/actions/preview-pdf
Authorization: Bearer <token>
```

**Note:** PDF generation is not yet implemented. Returns:

```json
{ "previewUrl": null, "note": "PDF generation pending" }
```

---

## Dashboard

### Stats Cards

```
GET /dashboard/stats
Authorization: Bearer <token>
```

**Response `data`:**

```json
{
  "totalRequests": { "value": 142, "vsLastMonth": 12.5 },
  "pendingRequests": { "value": 38,  "vsLastMonth": -5.0 },
  "sentOffers":     { "value": 67,  "vsLastMonth": 8.3  },
  "declined":       { "value": 14,  "vsLastMonth": 0.0  }
}
```

`vsLastMonth` is a percentage change vs the previous calendar month (1 decimal place). Positive = up, negative = down.

---

### Recent Offers Table

```
GET /dashboard/recent-offers?limit=10
Authorization: Bearer <token>
```

**Query:** `limit` (default 10, max 50)

**Response `data`:** Array of rows:

```json
[
  {
    "id": "uuid",
    "referenceNumber": 2458,
    "offerId": "#2458",
    "customer": "TechCorp Ltd",
    "destination": "Barcelona, Spain",
    "checkinDate": "2026-06-10T00:00:00.000Z",
    "checkoutDate": "2026-06-15T00:00:00.000Z",
    "nights": 5,
    "totalRooms": 15,
    "groupSize": 30,
    "totalSell": 32748,
    "totalBuy": 28500,
    "margin": 4248,
    "marginPct": 13.0,
    "status": "sent",
    "proposalId": "uuid",
    "createdAt": "2026-03-05T12:00:00.000Z"
  }
]
```

---

## Hotel Database Search (autocomplete)

```
GET /hotels/search?q=barcelona&destinationId=123&starRating=4&limit=20
Authorization: Bearer <token>
```

**Query parameters:**

| Param           | Type   | Notes                          |
|-----------------|--------|--------------------------------|
| `q`             | string | Hotel name search              |
| `destinationId` | int    | Filter by destination          |
| `starRating`    | float  | Filter by star rating (±0.49)  |
| `limit`         | int    | Default 20                     |
| `offset`        | int    | Default 0                      |

---

## Status Enums

### BookingRequest status

| Value        | Meaning                                |
|--------------|----------------------------------------|
| `draft`      | Not yet submitted / incomplete form    |
| `pending`    | Submitted, awaiting agent action       |
| `processing` | Agent working on quotes                |
| `completed`  | Proposal sent and accepted             |
| `cancelled`  | Request cancelled                      |

### Proposal status

| Value      | Meaning                     |
|------------|-----------------------------|
| `draft`    | Work in progress            |
| `sent`     | Sent to client              |
| `accepted` | Client accepted             |
| `declined` | Client declined             |

---

## Common HTTP Error Codes

| HTTP | `error` code        | Meaning                                  |
|------|---------------------|------------------------------------------|
| 400  | `VALIDATION_ERROR`  | Request body/query failed validation     |
| 401  | `UNAUTHORIZED`      | Missing or invalid Bearer token          |
| 403  | `FORBIDDEN`         | Token valid but not permitted            |
| 404  | `NOT_FOUND`         | Resource not found                       |
| 409  | `PROPOSAL_LOCKED`   | Proposal locked by another user          |
| 429  | `rate_limited`      | Too many requests                        |
| 500  | `INTERNAL_ERROR`    | Server error                             |

---

## Complete Create-Request-to-Send-Proposal Flow

```
1. POST /requests                         → get requestId
2. POST /requests/:id/hotel-search        → get hotel options (TIDs + sessionIds)
3. POST /requests/:id/hotel-search/option-details  → get per-night pricing for selected hotels
4. POST /requests/:id/hotel-search/calculate-price → get recommended sell price
5. POST /requests/:requestId/proposals    → create proposal → get proposalId
6. POST /proposals/:id/actions/lock       → lock for editing
7. POST /proposals/:id/hotels             → add each hotel (repeat as needed)
8. POST /proposals/:id/services           → add extra services (optional)
9. POST /proposals/:id/actions/save-draft → save progress
10. POST /proposals/:id/actions/send      → send to client
```
