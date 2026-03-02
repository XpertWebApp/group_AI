# Sett Project — Group Booking API

Backend REST API for the manual group booking request and proposal workflow.

## Tech Stack

- **Node.js + Express** (TypeScript)
- **Prisma ORM** (PostgreSQL)
- **Zod** validation
- **Jest + Supertest** testing

---

## Getting Started

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Copy `.env.example` → `.env` and set:
```
DATABASE_URL=postgresql://user:password@localhost:5432/mydb
JWT_SECRET=your-secret
```

### 3. Run migrations
```bash
npm run migrate
```

### 4. Start dev server
```bash
npm run dev
```

### 5. Run tests
```bash
npm test
```

### 6. Type-check
```bash
npx tsc --noEmit
```

---

## Totals Calculation Rules

```
totalBuy  = Σ(proposal_hotels.totalPrice where deletedAt IS NULL)
           + Σ(proposal_services.buyPrice × quantity)

totalSell = hotelBuy × (1 + globalMarkupPercent/100)   [if markupSettings.globalMarkupPercent set]
           + Σ(proposal_services.sellPrice × quantity)
```

All monetary values are stored as `Decimal(12,2)` and computed with `decimal.js` to avoid float issues.

---

## API Reference

Base URL: `http://localhost:3000/api/v1`

All endpoints require `Authorization: Bearer <token>`.

---

### BookingRequests

#### Create Booking Request
```bash
curl -X POST http://localhost:3000/api/v1/requests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "companyName": "TechCorp",
    "contactName": "John Vestergaard",
    "contactEmail": "john@company.com",
    "contactPhone": "+1234567890",
    "currencyCode": "EUR",
    "destinationId": 123,
    "destinationName": "Barcelona, Spain",
    "checkinDate": "2026-03-15",
    "nights": 10,
    "rooms": { "single": 6, "double": 10, "twin": 5 },
    "nationalityCode": "DK",
    "budget": 100000,
    "specialRequirements": "Wheelchair access"
  }'
```
**Response:** `201 Created` with booking request object, `Location` header.

#### Get Booking Request
```bash
curl http://localhost:3000/api/v1/requests/:id \
  -H "Authorization: Bearer $TOKEN"
```

#### Update Booking Request
```bash
curl -X PATCH http://localhost:3000/api/v1/requests/:id \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "nights": 12, "specialRequirements": "Updated" }'
```

#### Get Request Summary
```bash
curl http://localhost:3000/api/v1/requests/:id/summary \
  -H "Authorization: Bearer $TOKEN"
```

---

### Proposals

#### Create Proposal on a Request
```bash
curl -X POST http://localhost:3000/api/v1/requests/:requestId/proposals \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "notes": "Initial draft offer", "markupSettings": { "globalMarkupPercent": 20 } }'
```
**Response:** `201 Created`, `Location` header.

#### Get Proposal (with hotels, services, totals)
```bash
curl http://localhost:3000/api/v1/proposals/:id \
  -H "Authorization: Bearer $TOKEN"
```

#### Update Proposal Metadata
```bash
curl -X PATCH http://localhost:3000/api/v1/proposals/:id \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "notes": "Updated notes", "markupSettings": { "globalMarkupPercent": 25 } }'
```

---

### Proposal Hotels

#### Add Hotel
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/hotels \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "hotelCode": "BDC-4782",
    "tid": "TID_123",
    "rooms": { "deluxe_double": { "net": 250.00, "sell": 300.00, "qty": 20, "nights": 5 } },
    "currency": "EUR",
    "totalPrice": 30000,
    "freeCancellation": true,
    "cancelDeadline": "2026-03-01T00:00:00Z"
  }'
```
**Response:** `201 Created` with hotel object and updated proposal totals.

#### Remove Hotel (soft-delete)
```bash
curl -X DELETE http://localhost:3000/api/v1/proposals/:id/hotels/:hotelId \
  -H "Authorization: Bearer $TOKEN"
```
**Response:** `200 OK` with updated totals.

#### List Hotels
```bash
curl http://localhost:3000/api/v1/proposals/:id/hotels \
  -H "Authorization: Bearer $TOKEN"
```

#### Adjust Hotel Pricing
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/hotels/:hotelId/adjust-pricing \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "totalPrice": 28000 }'
```

---

### Proposal Services

#### Add Service
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/services \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "serviceName": "Airport Transfer",
    "buyPrice": 1000,
    "sellPrice": 1200,
    "quantity": 2,
    "days": 1,
    "notes": "Return transfer included"
  }'
```
**Response:** `201 Created` with service and updated totals.

---

### Proposal Actions

#### Lock for Editing
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/actions/lock \
  -H "Authorization: Bearer $TOKEN"
```
Returns `409 Conflict` with lock owner info if locked by another user.

#### Unlock
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/actions/unlock \
  -H "Authorization: Bearer $TOKEN"
```

#### Save as Draft
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/actions/save-draft \
  -H "Authorization: Bearer $TOKEN"
```

#### Approve & Send
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/actions/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "sendToEmail": "client@company.com" }'
```
**Response:** `{ sent: true, emailSent: false, previewUrl: null, sendPlaceholder: true }`
*(Email sending is a future milestone)*

#### PDF Preview (placeholder)
```bash
curl -X POST http://localhost:3000/api/v1/proposals/:id/actions/preview-pdf \
  -H "Authorization: Bearer $TOKEN"
```
**Response:** `{ previewUrl: null, note: "PDF generation pending" }`

---

### Hotels Search

```bash
curl "http://localhost:3000/api/v1/hotels/search?q=Barcelona&destinationId=123&starRating=4&limit=20&offset=0" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Error Responses

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `validation_error` | Zod validation failed — includes `details` array |
| 401 | `UNAUTHORIZED` | Missing/invalid JWT |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `PROPOSAL_LOCKED` | Proposal locked by another user |
| 409 | `PROPOSAL_NOT_MODIFIABLE` | Proposal already sent/declined |
| 429 | `rate_limited` | Too many requests |

Lock conflict error example:
```json
{
  "error": {
    "code": "proposal_locked",
    "message": "Proposal is currently locked by another user",
    "owner": { "id": "user-uuid", "lockedAt": "2026-03-02T14:00:00Z" }
  }
}
```

---

## Audit Events

All key actions are logged to `audit.audit_events`:

| Action | Trigger |
|--------|---------|
| `create_request` | POST /requests |
| `update_request` | PATCH /requests/:id |
| `create_proposal` | POST /requests/:id/proposals |
| `update_proposal` | PATCH /proposals/:id |
| `add_hotel` | POST /proposals/:id/hotels |
| `remove_hotel` | DELETE /proposals/:id/hotels/:hotelId |
| `adjust_hotel_pricing` | POST /proposals/:id/hotels/:hotelId/adjust-pricing |
| `add_service` | POST /proposals/:id/services |
| `lock_proposal` | POST /proposals/:id/actions/lock |
| `unlock_proposal` | POST /proposals/:id/actions/unlock |
| `save_draft` | POST /proposals/:id/actions/save-draft |
| `send_proposal` | POST /proposals/:id/actions/send |
