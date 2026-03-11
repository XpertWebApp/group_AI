# SETT Backend — Frontend Integration Reference

> Last updated: Milestone 3 — AI Offer Generation Engine
> Backend base URL (development): `http://localhost:4000/api/v1`

---

## Global Response Envelope

Every endpoint returns the same wrapper:

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
  "message": "contactEmail: Invalid email",
  "error": { "code": "validation_error", "message": "..." }
}
```

---

## Authentication

### Login

```
POST /auth/login
Content-Type: application/json
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
Content-Type: application/json
```

**Body:** `{ "refreshToken": "eyJ..." }`

Response: same shape as login.

---

### Logout

```
POST /auth/logout
Authorization: Bearer <accessToken>
```

---

### Using the Token

Include on every protected request:
```
Authorization: Bearer <accessToken>
```

When you receive a `401`, call `/auth/refresh` and retry with the new token. If refresh also fails, redirect to login.

---

## ⚠️ Critical: Destination ID Lookup (MUST do this before creating a request)

> **Bug that caused 0 hotel results:** The destination ID in a booking request must come from the database — do NOT hardcode a number. The search API (`/hotel-search`) looks up hotels by `destinationId`. If the ID is wrong or doesn't exist, zero hotels are returned.

### Search Destinations (type-ahead)

```
GET /destinations/search?q=Barcelona&limit=10
Authorization: Bearer <token>
```

| Param   | Default | Notes                       |
|---------|---------|-----------------------------|
| `q`     | —       | Min 2 characters            |
| `limit` | 10      | Max 50                      |

**Response `data`:**
```json
[
  { "id": 4503, "name": "Barcelona",         "countryCode": "ES", "region": null },
  { "id": 4502, "name": "Barcelona",         "countryCode": "VE", "region": null },
  { "id": 695088, "name": "Barcelona Airports", "countryCode": "ES", "region": null }
]
```

Results are sorted: exact-start matches first, then shortest name first (most specific city at top).

**UI pattern:**
1. User types in the destination field → debounce 300ms → call `/destinations/search?q=<input>`
2. Show dropdown of results, each showing `name (countryCode)` e.g. "Barcelona (ES)"
3. When user selects one, store both `id` and `name` in form state
4. Submit `destinationId: 4503` and `destinationName: "Barcelona"` in the request body

---

## Booking Requests

### Create Request (4-step form)

```
POST /requests
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**
```json
{
  "destinationId": 4503,
  "destinationName": "Barcelona",
  "checkinDate": "2026-06-10",
  "checkoutDate": "2026-06-15",
  "nights": 5,
  "starRating": 4,
  "budgetRange": "€200-300/night",
  "budget": 15000,
  "groupType": "corporate",
  "groupSize": 30,
  "currencyCode": "EUR",
  "nationalityCode": "GB",

  "rooms": {
    "single": 5,
    "double": 10,
    "twin": 0,
    "triple": 0,
    "quadruple": 0,
    "suites": 0,
    "extraRoomsNote": "2 accessible rooms needed"
  },
  "breakfastPreference": "BB",
  "hotelLocation": "central",
  "specialRequirements": "Ground floor rooms if possible",

  "companyName": "TechCorp Ltd",
  "firstName": "John",
  "lastName": "Doe",
  "contactEmail": "john.doe@techcorp.com",
  "contactPhone": "+441234567890",
  "guestListFileKey": "uploads/guestlist.xlsx",
  "customerNotes": "VIP group, priority check-in",

  "termsAndConditions": "...",
  "cancellationConditions": "..."
}
```

**Required fields:** `destinationId`, `destinationName`, `checkinDate`, `companyName`, `firstName`, `lastName`, `contactEmail`, `contactPhone`, plus either `checkoutDate` or `nights`.

**Enums:**
- `breakfastPreference`: `"BB"` (breakfast) | `"RO"` (room only)
- `hotelLocation`: `"central"` | `"outside_city_center"`

**Response `201`:**
```json
{
  "id": "uuid",
  "referenceNumber": 2458,
  "status": "pending",
  "companyName": "TechCorp Ltd",
  "contactName": "John Doe",
  "destinationId": 4503,
  "destinationName": "Barcelona",
  "checkinDate": "2026-06-10T00:00:00.000Z",
  "nights": 5,
  "rooms": { "single": 5, "double": 10 },
  "createdAt": "2026-03-05T12:00:00.000Z"
}
```

Save the `id` — it is needed for all subsequent hotel search and proposal steps.

---

### List Requests

```
GET /requests?page=1&limit=20&search=techcorp&status=ai_generated
Authorization: Bearer <token>
```

| Param       | Type   | Default     | Notes                                                                                     |
|-------------|--------|-------------|-------------------------------------------------------------------------------------------|
| `page`      | int    | 1           |                                                                                           |
| `limit`     | int    | 20          | max 100                                                                                   |
| `search`    | string | —           | Searches company name, destination, email, first/last name, `#referenceNumber`            |
| `status`    | string | —           | `pending` \| `draft` \| `processing` \| `ai_generated` \| `completed` \| `cancelled`     |
| `dateFrom`  | date   | —           | ISO date string, filters by createdAt                                                     |
| `dateTo`    | date   | —           | ISO date string                                                                           |
| `sortBy`    | string | `createdAt` | `createdAt` \| `checkinDate` \| `referenceNumber`                                         |
| `sortOrder` | string | `desc`      | `asc` \| `desc`                                                                           |

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
      "destinationName": "Barcelona",
      "checkinDate": "2026-06-10T00:00:00.000Z",
      "nights": 5,
      "status": "ai_generated",
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

### Get Request Detail

```
GET /requests/:id
Authorization: Bearer <token>
```

Returns the full request object with all fields including rooms, policies, proposals.

---

### Update Request

```
PATCH /requests/:id
Authorization: Bearer <token>
Content-Type: application/json
```

Same fields as create, all optional. Only send what changed.

---

## Hotel Search Flow

Call these endpoints **after** a booking request exists. The `requestId` from the create step is required.

### Step 1 — Run Hotel Search

```
POST /requests/:id/hotel-search
Authorization: Bearer <token>
Content-Type: application/json
```

> This call takes **30–45 seconds**. Show a loading spinner.

**Body (all optional — defaults are shown):**
```json
{
  "mealType": "BB",
  "includeAlternativeStars": true,
  "waitSeconds": 35,
  "currencyCode": "EUR",
  "nationalityCode": "HU"
}
```

| Field                   | Default        | Notes                                              |
|-------------------------|----------------|----------------------------------------------------|
| `mealType`              | from request   | `"BB"` \| `"RO"` \| `"HB"` \| `"FB"` \| `"AI"`  |
| `includeAlternativeStars` | `true`       | Also return hotels at ±1 star rating               |
| `waitSeconds`           | `35`           | Range 5–60. Don't go below 30 for best results     |
| `currencyCode`          | from request   |                                                    |
| `nationalityCode`       | from request   |                                                    |

**Response `data`:**
```json
{
  "requestId": "uuid",
  "sessionId": "e962be54-ebd1-46a9-9059-e5b8c4cedb78",
  "finished": true,
  "totalRoomsRequested": 15,
  "summary": {
    "total": 42,
    "included": 28,
    "flagged": 9,
    "omitted": 5
  },
  "results": [ ],
  "alternativeResults": [ ]
}
```

`results` contains hotels matching the requested star rating.
`alternativeResults` contains hotels at ±1 star — show these in a secondary section.

Both arrays contain objects of this shape:

**`HotelResult` object:**
```json
{
  "hotelCode": "Ru0AcMoJrZg=",
  "hotelName": "Jumeirah Beach",
  "starRating": 5,
  "imageUrl": "/api/v1/hotels/image?key=eoYaG3WL9qzdm6Np...",
  "address": "PO Box 11416, Umm Suqeim, Dubai",
  "addressCity": "Dubai",
  "addressCountry": "AE",
  "sessionId": "e962be54-ebd1-46a9-9059-e5b8c4cedb78",
  "status": "include",
  "totalAvailableRooms": 45,
  "highestMidRangePrice": 187.50,
  "currency": "EUR",
  "bestOption": {
    "tid": "00000000000051772101473458",
    "sessionId": "e962be54-ebd1-46a9-9059-e5b8c4cedb78",
    "supplierCode": "EANRP",
    "buyingPricePerRoomPerNight": 187.50,
    "currency": "EUR",
    "freeCancellation": true,
    "cancelDeadline": "2026-05-26T19:59:59.000Z",
    "mealType": "BB",
    "mealName": "Free breakfast",
    "roomDescriptions": ["Club Room (Ocean) - 1 King Bed"]
  },
  "usableOptions": [ ],
  "selectedOptions": [ ],
  "supplierSplit": [ ],
  "note": null
}
```

**Key fields for the UI:**

| Field | Use for |
|-------|---------|
| `hotelName`, `starRating`, `imageUrl`, `address` | Hotel card header. `imageUrl` is a relative path — prefix with the API base URL (e.g. `http://localhost:4000`). It is `null` if the hotel has no images. |
| `status` | Availability badge (see table below) |
| `bestOption.buyingPricePerRoomPerNight` | Display as buying price — apply markup before showing to customer |
| `bestOption.mealName` | Meal plan badge |
| `bestOption.cancelDeadline` | "Free cancellation until {date}" |
| `bestOption.tid` + `bestOption.sessionId` | Required for option-details and add-to-proposal calls |
| `supplierSplit` | **INTERNAL ONLY — never show to customer** |

**Hotel `status` values:**

| Value | Meaning | UI treatment |
|-------|---------|--------------|
| `"include"` | Hotel can fulfil the full room count | Show normally |
| `"flag"` | Risky — inventory overlap likely | Yellow warning badge |
| `"omit"` | Insufficient capacity for group size | Hide or grey out |

---

### Step 2 — Get Option Details

After the agent selects hotels to quote, call this to get exact per-night pricing and cancellation policy. Results are cached for 2 hours.

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
      "sessionId": "e962be54-ebd1-46a9-9059-e5b8c4cedb78",
      "tid": "00000000000051772101473458",
      "hotelCode": "Ru0AcMoJrZg="
    }
  ]
}
```

Get `sessionId`, `tid`, and `hotelCode` from `bestOption` in the hotel search result. Max 20 selections per call.

**Response `data`:**
```json
[
  {
    "tid": "00000000000051772101473458",
    "hotelCode": "Ru0AcMoJrZg=",
    "cached": false,
    "parsed": {
      "nonRefundable": false,
      "cxlDeadline": "2026-05-26T19:59:59.000Z",
      "mealType": "BB",
      "mealName": "Free breakfast",
      "daypricesTotal": 14062.50,
      "daypricesCurrency": "EUR",
      "providerPrice": 12500.00,
      "essentialInfo": "Check-in from 15:00. Photo ID required.",
      "roomBreakdown": [
        {
          "roomId": 1,
          "description": "Club Room (Ocean) - 1 King Bed",
          "prices": [
            { "date": "2026-06-10", "price": 250.00 },
            { "date": "2026-06-11", "price": 250.00 },
            { "date": "2026-06-12", "price": 300.00 }
          ]
        }
      ],
      "cancellationPolicy": {
        "nonRefundable": false,
        "deadline": "2026-05-26T19:59:59.000Z",
        "conditions": [
          {
            "fromDate": "2026-05-26",
            "toDate": "2026-06-10",
            "amount": 500.00,
            "currency": "EUR",
            "text": "One night penalty if cancelled after 26 May"
          }
        ],
        "comment": "Free cancellation until 26 May 2026"
      },
      "supplements": []
    }
  }
]
```

| Field | Use for |
|-------|---------|
| `parsed.cxlDeadline` | "Free cancellation until {date}" |
| `parsed.cancellationPolicy` | Full policy modal / tooltip |
| `parsed.mealName` | Meal plan label |
| `parsed.daypricesTotal` | Total buying cost for all 3 search rooms (see pricing note below) |
| `parsed.roomBreakdown` | Per-night price table per room |
| `parsed.essentialInfo` | Important hotel notes section |

> **Pricing note:** `daypricesTotal` is the total price for the 3 rooms used in the search (Oliver's rule: always search with 3 rooms). The server automatically divides this by `(totalRooms × nights)` when building the proposal — you don't need to do this yourself.

---

### Step 3 — Calculate Customer Price

```
POST /requests/:id/hotel-search/calculate-price
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**
```json
{
  "buyingPrice": 187.50,
  "markupPercent": 18
}
```

`buyingPrice` = `bestOption.buyingPricePerRoomPerNight` from the search result (per room per night).
`markupPercent` is optional, defaults to 18.

**Response `data`:**
```json
{
  "buyingPrice": 187.50,
  "sellPrice": 221,
  "markupPercent": 18
}
```

**Price psychology is applied automatically:** numbers ending in `0` → subtract 2 (€200 → €198), numbers ending in `5` → subtract 1 (€195 → €194).

`sellPrice` is **per room per night**. Total = `sellPrice × totalRooms × nights`.

This is the price to show the customer.

---

## Proposals

### Create Proposal

```
POST /requests/:requestId/proposals
Authorization: Bearer <token>
Content-Type: application/json
```

**Body (all optional):**
```json
{
  "notes": "Our best offer for your group",
  "markupSettings": { "globalMarkupPercent": 18 }
}
```

**Response `201`:** Proposal object including `id`.

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

Returns proposal with its hotels, services, and totals.

---

### Update Proposal Metadata

```
PATCH /proposals/:id
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:** `notes` and/or `markupSettings` (both optional).

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
  "hotelCode": "Ru0AcMoJrZg=",
  "tid": "00000000000051772101473458",
  "currency": "EUR",
  "totalPrice": 33150,
  "freeCancellation": true,
  "cancelDeadline": "2026-05-26T19:59:59.000Z",
  "supplierCode": "EANRP",
  "rooms": {
    "Club Room (Ocean) - 1 King Bed": {
      "net": 187.50,
      "sell": 221,
      "qty": 15,
      "nights": 5
    }
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
    "Club Room (Ocean) - 1 King Bed": { "sell": 308 }
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
  "notes": "Return transfer × 2 coaches"
}
```

Only `serviceName` is required.

---

### Lock Proposal

```
POST /proposals/:id/actions/lock
Authorization: Bearer <token>
```

Lock expires automatically after 15 minutes.

**409 if locked by another user:**
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

If omitted, sends to the request's `contactEmail`. Sets status → `sent`.

---

### Preview PDF

```
POST /proposals/:id/actions/preview-pdf
Authorization: Bearer <token>
```

> PDF generation is not yet implemented. Returns `{ "previewUrl": null, "note": "PDF generation pending" }`.

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
  "totalRequests":  { "value": 142, "vsLastMonth": 12.5 },
  "pendingRequests":{ "value": 38,  "vsLastMonth": -5.0 },
  "sentOffers":     { "value": 67,  "vsLastMonth": 8.3  },
  "declined":       { "value": 14,  "vsLastMonth": 0.0  }
}
```

`vsLastMonth` is a percentage change vs the previous calendar month (positive = up, negative = down).

---

### Recent Offers Table

```
GET /dashboard/recent-offers?limit=10
Authorization: Bearer <token>
```

**Response `data`:**
```json
[
  {
    "id": "uuid",
    "referenceNumber": 2458,
    "offerId": "#2458",
    "customer": "TechCorp Ltd",
    "destination": "Barcelona",
    "checkinDate": "2026-06-10T00:00:00.000Z",
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

### Notifications

#### List Notifications

```
GET /dashboard/notifications?unread=true&limit=20
Authorization: Bearer <token>
```

| Param    | Default | Notes                          |
|----------|---------|--------------------------------|
| `unread` | false   | `true` to return only unread   |
| `limit`  | 20      |                                |

**Response `data`:**
```json
[
  {
    "id": "uuid",
    "type": "new_offer_ready",
    "title": "New offer ready — #2458",
    "message": "AI offer for John Doe (Barcelona) is ready for review.",
    "entityId": "request-uuid",
    "entityType": "booking_request",
    "read": false,
    "createdAt": "2026-03-06T10:00:00.000Z"
  }
]
```

**Notification `type` values:**

| Type | When |
|------|------|
| `new_offer_ready` | Webhook request processed successfully, AI offer generated |
| `offer_generation_failed` | Pipeline failed for a webhook request |

#### Mark One Read

```
PATCH /dashboard/notifications/:id/read
Authorization: Bearer <token>
```

#### Mark All Read

```
POST /dashboard/notifications/read-all
Authorization: Bearer <token>
```

---

## Hotel Images

Hotel images are served through a SETT server-side proxy that fetches from WBE's content CDN (`uatcontent.wbeapi.com`). The `imageUrl` field in `HotelResult` contains the relative path — prefix it with the API base URL.

```
GET /hotels/image?key={imageKey}
```

No auth token required. Rate limited to 300 requests/minute.

**How it works:**
1. The search response includes `imageUrl` on each hotel (e.g. `"/api/v1/hotels/image?key=bIoq5Jji83SD..."`)
2. The backend proxy receives the `key`, then fetches the actual image from WBE's content CDN:
   `GET https://uatcontent.wbeapi.com/Image/getimage?pic={imageKey}`
3. The binary image is forwarded to the frontend with proper `Content-Type` header

**Frontend usage:**
```tsx
// From hotel search result: hotel.imageUrl = "/api/v1/hotels/image?key=bIoq5Jji83SD..."

const API_BASE_URL = 'http://localhost:4000'; // or your deployed server URL

// Build full image src
const imageSrc = hotel.imageUrl
  ? `${API_BASE_URL}${hotel.imageUrl}`
  : null;

// React example
<img
  src={imageSrc ?? '/placeholder-hotel.jpg'}
  alt={hotel.hotelName}
  onError={(e) => {
    (e.target as HTMLImageElement).src = '/placeholder-hotel.jpg';
  }}
/>
```

**Important notes:**
- `imageUrl` is `null` when no image exists in the database — always show a fallback placeholder
- Response is cached with `Cache-Control: public, max-age=86400` (24 hours) — browser will cache automatically
- The proxy returns the original content type from WBE (typically `image/jpeg`)
- If the upstream image is unavailable, the proxy returns `404` with `{ "error": { "code": "not_found", "message": "Image not available" } }` — use `onError` handler to show placeholder

---

## Hotel Database Search (for hotel name autocomplete)

```
GET /hotels/search?q=hilton&destinationId=4503&starRating=4&limit=20
Authorization: Bearer <token>
```

| Param           | Type   | Notes                         |
|-----------------|--------|-------------------------------|
| `q`             | string | Hotel name search             |
| `destinationId` | int    | Filter by destination         |
| `starRating`    | float  | Filter by star rating (±0.49) |
| `limit`         | int    | Default 20                    |
| `offset`        | int    | Default 0, for pagination     |

---

## Status Reference

### BookingRequest `status`

| Value          | Badge colour | Meaning |
|----------------|-------------|---------|
| `pending`      | grey        | Created, waiting for agent to act |
| `processing`   | blue        | AI offer generation pipeline running |
| `ai_generated` | green       | AI offer ready — agent should review |
| `draft`        | yellow      | Agent manually started editing |
| `completed`    | green       | Proposal sent and accepted |
| `cancelled`    | red         | Request cancelled |

**Status flow for webhook-submitted requests:**
```
pending → processing → ai_generated → completed
```

**Status flow for manually-created requests:**
```
pending → draft → (hotel search) → completed
```

### Proposal `status`

| Value      | Meaning                   |
|------------|---------------------------|
| `draft`    | Work in progress          |
| `sent`     | Sent to client            |
| `accepted` | Client accepted           |
| `declined` | Client declined           |

---

## HTTP Error Codes

| HTTP | `code`              | When                                      |
|------|---------------------|-------------------------------------------|
| 400  | `validation_error`  | Request body/query failed validation      |
| 401  | `unauthorized`      | Missing or invalid Bearer token           |
| 403  | `forbidden`         | Token valid but not permitted             |
| 404  | `NOT_FOUND`         | Resource not found                        |
| 409  | `PROPOSAL_LOCKED`   | Proposal locked by another user           |
| 429  | `rate_limited`      | Too many requests                         |
| 500  | `internal_error`    | Server error                              |

---

## Rate Limits

| Endpoint group             | Limit               |
|----------------------------|---------------------|
| `POST /requests`           | 50 per 15 minutes   |
| `POST /requests/:id/hotel-search` | 10 per minute |
| All other endpoints        | No hard rate limit  |

---

## Complete Manual Flow (Create Request → Send Proposal)

```
0. GET  /destinations/search?q=Barcelona     → pick destination, get its id
1. POST /requests                             → create request (use real destinationId)
2. POST /requests/:id/hotel-search            → run WBE search (30–45s, show spinner)
3. POST /requests/:id/hotel-search/option-details  → get per-night pricing for selected hotels
4. POST /requests/:id/hotel-search/calculate-price → get customer sell price per room/night
5. POST /requests/:requestId/proposals        → create proposal
6. POST /proposals/:id/actions/lock           → lock for editing
7. POST /proposals/:id/hotels                 → add each selected hotel (repeat per hotel)
8. POST /proposals/:id/services               → add extras (optional)
9. POST /proposals/:id/actions/save-draft     → save progress
10. POST /proposals/:id/actions/send          → send to client
```

## Webhook (Automatic) Flow

When a group booking form is submitted via Wix, the backend handles everything automatically:

```
Wix form submitted
  → POST /webhook (no auth, uses x-webhook-secret header)
  → BookingRequest created (status: pending)
  → status → processing (pipeline starts)
  → WBE hotel search runs in background
  → Proposal created with top 5 hotels
  → status → ai_generated
  → Staff notification sent (email + in-app)
  → Notification appears in /dashboard/notifications
```

Agent's job after this: open the request, review the auto-generated proposal, adjust pricing/hotels if needed, then send to the client.
