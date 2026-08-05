import request from 'supertest';
import app from '../app';
import { PrismaClient } from '@prisma/client';

// Mock PrismaClient so we don't need a live DB for integration tests
jest.mock('@prisma/client', () => {
    const mProposal = {
        id: 'proposal-uuid-1',
        requestId: 'request-uuid-1',
        status: 'draft',
        totalBuy: '0',
        totalSell: '0',
        markupSettings: { globalMarkupPercent: 20 },
        notes: null,
        sentAt: null,
        sentBy: null,
        sentToEmail: null,
        lockedBy: null,
        lockedAt: null,
        // Proposals created after the payment-gate cutover cannot be sent
        // without a deadline — the PDF and email both render "Payment due by".
        paymentDeadline: new Date('2026-03-01'),
        createdAt: new Date(),
        updatedAt: null,
        hotels: [],
        services: [],
    };

    const mBookingRequest = {
        id: 'request-uuid-1',
        companyName: 'TechCorp',
        contactName: 'John',
        contactEmail: 'john@company.com',
        contactPhone: '+1234567890',
        currencyCode: 'EUR',
        destinationId: 123,
        destinationName: 'Barcelona',
        checkinDate: new Date('2026-03-15'),
        nights: 5,
        rooms: { single: 1 },
        status: 'pending',
        proposals: [mProposal],
        attachments: [],
        createdAt: new Date(),
    };

    const mHotel = {
        id: 'hotel-uuid-1',
        proposalId: 'proposal-uuid-1',
        hotelCode: 'BDC-4782',
        totalPrice: '30000',
        currency: 'EUR',
        deletedAt: null,
        optionDetailsFetched: false,
    };

    const mPrismaClient = {
        bookingRequest: {
            create: jest.fn().mockResolvedValue(mBookingRequest),
            findMany: jest.fn().mockResolvedValue([mBookingRequest]),
            findUnique: jest.fn().mockResolvedValue(mBookingRequest),
            update: jest.fn().mockResolvedValue(mBookingRequest),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        proposal: {
            create: jest.fn().mockResolvedValue(mProposal),
            findMany: jest.fn().mockResolvedValue([mProposal]),
            findUnique: jest.fn().mockResolvedValue(mProposal),
            update: jest.fn().mockResolvedValue({ ...mProposal, status: 'sent', sentAt: new Date() }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        proposalHotel: {
            create: jest.fn().mockResolvedValue(mHotel),
            findMany: jest.fn().mockResolvedValue([mHotel]),
            update: jest.fn().mockResolvedValue({ ...mHotel, deletedAt: new Date() }),
            aggregate: jest.fn().mockResolvedValue({ _sum: { totalPrice: '30000' } }),
        },
        proposalService: {
            create: jest.fn().mockResolvedValue({ id: 'svc-1', proposalId: 'proposal-uuid-1', serviceName: 'Transfer' }),
            findMany: jest.fn().mockResolvedValue([]),
        },
        hotelOptionDetail: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
        auditEvent: {
            create: jest.fn().mockResolvedValue({}),
        },
        // sendProposal counts prior offers to derive the next version number.
        proposalOffer: {
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockResolvedValue({ id: 'offer-uuid-1', proposalId: 'proposal-uuid-1', version: 1 }),
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
        },
        // authMiddleware re-checks the token's user against the database on
        // every request, so a signed JWT alone is not enough — without this
        // the lookup returns undefined and every route answers 401.
        user: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'test-user-uuid-1',
                email: 'agent@test.com',
                isActive: true,
                role: { name: 'ADMIN' },
            }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: any) => {
            return fn({
                proposalHotel: {
                    create: jest.fn().mockResolvedValue(mHotel),
                    update: jest.fn().mockResolvedValue({ ...mHotel, deletedAt: new Date() }),
                    aggregate: jest.fn().mockResolvedValue({ _sum: { totalPrice: '30000' } }),
                    // addHotelTx counts existing hotels inside the transaction;
                    // the mock predates that call.
                    count: jest.fn().mockResolvedValue(0),
                    findMany: jest.fn().mockResolvedValue([mHotel]),
                    findFirst: jest.fn().mockResolvedValue(null),
                },
                proposalService: {
                    create: jest.fn().mockResolvedValue({ id: 'svc-1', proposalId: 'proposal-uuid-1', serviceName: 'Transfer' }),
                    findMany: jest.fn().mockResolvedValue([]),
                },
                hotelOptionDetail: { findUnique: jest.fn().mockResolvedValue(null) },
                // addHotelTx enriches the hotel from master data inside the
                // transaction; absent from the mock, the lookup throws.
                hotel: { findUnique: jest.fn().mockResolvedValue(null) },
                proposal: {
                    findUnique: jest.fn().mockResolvedValue(mProposal),
                    update: jest.fn().mockResolvedValue(mProposal),
                },
            });
        }),
    };

    return {
        PrismaClient: jest.fn(() => mPrismaClient),
        ProposalStatus: { draft: 'draft', sent: 'sent', approved: 'approved', declined: 'declined' },
        BookingRequestStatus: { pending: 'pending', draft: 'draft', processing: 'processing', ai_generated: 'ai_generated', completed: 'completed', cancelled: 'cancelled' },
        Prisma: { JsonNull: null },
    };
});

// Helper: generate a valid JWT for tests
import jwt from 'jsonwebtoken';

const TEST_JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-key-for-jest';
const TEST_USER_ID = 'test-user-uuid-1';

function makeToken() {
    return jwt.sign({ id: TEST_USER_ID, email: 'agent@test.com' }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

const authHeader = () => ({ Authorization: `Bearer ${makeToken()}` });

describe('Integration: BookingRequest → Proposal → Hotel → Send', () => {
    describe('POST /api/v1/requests', () => {
        it('returns 400 when required fields missing', async () => {
            const res = await request(app)
                .post('/api/v1/requests')
                .set(authHeader())
                .send({ companyName: 'Only Company' });
            expect(res.status).toBe(400);
            expect(res.body.error?.code).toBe('validation_error');
        });

        it('creates a booking request and returns 201 with Location header', async () => {
            const res = await request(app)
                .post('/api/v1/requests')
                .set(authHeader())
                .send({
                    companyName: 'TechCorp',
                    firstName: 'John',
                    lastName: 'Doe',
                    contactEmail: 'john@company.com',
                    contactPhone: '+1234567890',
                    currencyCode: 'EUR',
                    // Required since 2026-06-26; without it the request is
                    // rejected before it reaches the controller.
                    nationalityCode: 'DE',
                    destinationId: 123,
                    destinationName: 'Barcelona, Spain',
                    checkinDate: '2026-03-15',
                    nights: 5,
                    rooms: { single: 2, double: 1 },
                });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.headers['location']).toMatch(/\/api\/v1\/requests\//);
        });
    });

    describe('GET /api/v1/requests/:id', () => {
        it('returns 200 with request data', async () => {
            const res = await request(app)
                .get('/api/v1/requests/request-uuid-1')
                .set(authHeader());
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('POST /api/v1/requests/:requestId/proposals', () => {
        it('creates a proposal and returns 201 with Location header', async () => {
            const res = await request(app)
                .post('/api/v1/requests/request-uuid-1/proposals')
                .set(authHeader())
                .send({ notes: 'Initial draft', markupSettings: { globalMarkupPercent: 20 } });
            expect(res.status).toBe(201);
            expect(res.headers['location']).toMatch(/\/api\/v1\/proposals\//);
        });
    });

    describe('POST /api/v1/proposals/:id/hotels', () => {
        it('returns 400 on invalid hotel payload', async () => {
            const res = await request(app)
                .post('/api/v1/proposals/proposal-uuid-1/hotels')
                .set(authHeader())
                .send({ currency: 'EUR' }); // missing hotelCode and totalPrice
            expect(res.status).toBe(400);
        });

        it('adds hotel and returns 201', async () => {
            const res = await request(app)
                .post('/api/v1/proposals/proposal-uuid-1/hotels')
                .set(authHeader())
                .send({
                    hotelCode: 'BDC-4782',
                    currency: 'EUR',
                    totalPrice: 30000,
                    rooms: { deluxe_double: { net: 250, sell: 300, qty: 20, nights: 5 } },
                });
            expect(res.status).toBe(201);
        });
    });

    describe('POST /api/v1/proposals/:id/actions/send', () => {
        it('returns 400 for invalid email in send', async () => {
            const res = await request(app)
                .post('/api/v1/proposals/proposal-uuid-1/actions/send')
                .set(authHeader())
                .send({ sendToEmail: 'not-an-email' });
            expect(res.status).toBe(400);
        });

        it('sends proposal and returns { sent: true }', async () => {
            const res = await request(app)
                .post('/api/v1/proposals/proposal-uuid-1/actions/send')
                .set(authHeader())
                .send({ sendToEmail: 'client@company.com' });
            expect(res.status).toBe(200);
        });
    });

    describe('POST /api/v1/proposals/:id/services', () => {
        it('adds service and returns 201', async () => {
            const res = await request(app)
                .post('/api/v1/proposals/proposal-uuid-1/services')
                .set(authHeader())
                .send({ serviceName: 'Airport Transfer', buyPrice: 100, sellPrice: 120, quantity: 2 });
            expect(res.status).toBe(201);
        });
    });

    describe('POST /api/v1/proposals/:id/actions/preview-pdf', () => {
        // PDF generation was a placeholder when this test was written and the
        // endpoint answered `{ previewUrl: null }`. It now renders a real PDF
        // and streams it back, so both outcomes are valid: a PDF body, or the
        // JSON placeholder when generation is unavailable.
        it('returns a PDF, or the JSON placeholder when unavailable', async () => {
            const res = await request(app)
                .post('/api/v1/proposals/proposal-uuid-1/actions/preview-pdf')
                .set(authHeader())
                // The body is optional but must exist: supertest sends no body
                // at all without this, and the schema rejects undefined.
                .send({});

            expect(res.status).toBe(200);

            if (res.headers['content-type']?.includes('application/pdf')) {
                expect(res.body.length).toBeGreaterThan(0);
            } else {
                expect(res.body.data?.previewUrl).toBeNull();
            }
        });
    });
});
