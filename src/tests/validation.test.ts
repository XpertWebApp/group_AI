import request from 'supertest';
import app from '../app';

// ── Validation unit tests ───────────────────────────────────────────────────
import {
    CreateBookingRequestSchema,
    CreateProposalSchema,
    AddProposalHotelSchema,
    AddProposalServiceSchema,
    SendProposalSchema,
    UpdateBookingRequestSchema,
    ListRequestsQuerySchema,
} from '../validation/requestSchemas';

describe('Zod Validation Schemas', () => {
    describe('CreateBookingRequestSchema', () => {
        const valid = {
            companyName: 'TechCorp',
            firstName: 'John',
            lastName: 'Doe',
            contactEmail: 'john@company.com',
            contactPhone: '+1234567890',
            currencyCode: 'EUR',
            // Required since 2026-06-26 — the schema stopped allowing a silent
            // 'HU' default to reach WBE, so a payload without it is invalid.
            nationalityCode: 'DE',
            destinationId: 123,
            destinationName: 'Barcelona, Spain',
            checkinDate: '2026-03-15',
            nights: 5,
            rooms: { single: 2, double: 1 },
        };

        it('accepts a valid payload', () => {
            expect(CreateBookingRequestSchema.safeParse(valid).success).toBe(true);
        });

        it('rejects missing companyName', () => {
            const { companyName: _, ...rest } = valid;
            expect(CreateBookingRequestSchema.safeParse(rest).success).toBe(false);
        });

        it('rejects invalid email', () => {
            expect(CreateBookingRequestSchema.safeParse({ ...valid, contactEmail: 'not-email' }).success).toBe(false);
        });

        it('rejects invalid checkinDate', () => {
            expect(CreateBookingRequestSchema.safeParse({ ...valid, checkinDate: 'bad-date' }).success).toBe(false);
        });

        it('rejects nights < 1', () => {
            expect(CreateBookingRequestSchema.safeParse({ ...valid, nights: 0 }).success).toBe(false);
        });
    });

    describe('AddProposalHotelSchema', () => {
        const valid = { hotelCode: 'BDC-4782', currency: 'EUR', totalPrice: 30000 };

        it('accepts minimal valid payload', () => {
            expect(AddProposalHotelSchema.safeParse(valid).success).toBe(true);
        });

        it('rejects missing hotelCode', () => {
            const { hotelCode: _, ...rest } = valid;
            expect(AddProposalHotelSchema.safeParse(rest).success).toBe(false);
        });

        it('rejects negative totalPrice', () => {
            expect(AddProposalHotelSchema.safeParse({ ...valid, totalPrice: -1 }).success).toBe(false);
        });

        it('accepts rooms with net/sell/qty/nights', () => {
            const withRooms = {
                ...valid,
                rooms: { deluxe_double: { net: 250, sell: 300, qty: 20, nights: 5 } },
            };
            expect(AddProposalHotelSchema.safeParse(withRooms).success).toBe(true);
        });
    });

    describe('AddProposalServiceSchema', () => {
        it('accepts valid payload', () => {
            const payload = { serviceName: 'Airport Transfer', buyPrice: 100, sellPrice: 120 };
            expect(AddProposalServiceSchema.safeParse(payload).success).toBe(true);
        });

        it('rejects missing serviceName', () => {
            expect(AddProposalServiceSchema.safeParse({ buyPrice: 100 }).success).toBe(false);
        });
    });

    describe('CreateProposalSchema', () => {
        it('accepts empty object', () => {
            expect(CreateProposalSchema.safeParse({}).success).toBe(true);
        });
        it('accepts with notes and markupSettings', () => {
            expect(CreateProposalSchema.safeParse({ notes: 'hi', markupSettings: { globalMarkupPercent: 20 } }).success).toBe(true);
        });
    });

    describe('UpdateBookingRequestSchema', () => {
        it('accepts ai_generated as status', () => {
            expect(UpdateBookingRequestSchema.safeParse({ status: 'ai_generated' }).success).toBe(true);
        });

        it('rejects unknown status value', () => {
            expect(UpdateBookingRequestSchema.safeParse({ status: 'unknown_status' }).success).toBe(false);
        });
    });

    describe('ListRequestsQuerySchema', () => {
        it('accepts ai_generated as status filter', () => {
            expect(ListRequestsQuerySchema.safeParse({ status: 'ai_generated' }).success).toBe(true);
        });

        it('rejects unknown status filter', () => {
            expect(ListRequestsQuerySchema.safeParse({ status: 'unknown_status' }).success).toBe(false);
        });
    });

    describe('SendProposalSchema', () => {
        it('accepts empty body', () => {
            expect(SendProposalSchema.safeParse({}).success).toBe(true);
        });
        it('accepts valid email', () => {
            expect(SendProposalSchema.safeParse({ sendToEmail: 'a@b.com' }).success).toBe(true);
        });
        it('rejects invalid email', () => {
            expect(SendProposalSchema.safeParse({ sendToEmail: 'not-email' }).success).toBe(false);
        });
    });
});

// ── API endpoint tests ────────────────────────────────────────────────────────
describe('POST /api/v1/requests — validation', () => {
    it('returns 401 without auth token', async () => {
        const res = await request(app).post('/api/v1/requests').send({});
        expect(res.status).toBe(401);
    });
});

describe('GET /api/v1/requests/:id', () => {
    it('returns 401 without auth token', async () => {
        const res = await request(app).get('/api/v1/requests/some-id');
        expect(res.status).toBe(401);
    });
});
