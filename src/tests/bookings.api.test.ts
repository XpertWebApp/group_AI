/**
 * API-level tests for the booking endpoints.
 *
 * These cover the layer the unit tests do not: auth wiring, request
 * validation, route ordering, and — most importantly — the mapping from a
 * BookingFlowError code to an HTTP status. The frontend branches on those
 * status codes, so a wrong mapping is silently wrong rather than loud.
 *
 * The WBE booking service is mocked throughout. Real WBE behaviour is already
 * exercised by the certification runner against live UAT; what matters here is
 * the contract this server exposes, not what the supplier does.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';

// ── Prisma mock ─────────────────────────────────────────────────────────────
// authMiddleware re-checks the token's user against the database on every
// request, so a signed JWT alone is not enough — without this every route
// answers 401 regardless of what is under test.
jest.mock('@prisma/client', () => {
    const mPrisma = {
        user: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'test-user-uuid-1',
                email: 'agent@test.com',
                isActive: true,
                role: { name: 'ADMIN' },
            }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        $connect: jest.fn(),
        $disconnect: jest.fn(),
    };
    return {
        PrismaClient: jest.fn(() => mPrisma),
        Prisma: { DbNull: null, JsonNull: null },
        // Repositories read these at module load, so a missing enum throws
        // before any test runs. Mirrors prisma/schema.prisma.
        JobStatus: { IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', FAILED: 'FAILED' },
        BookingRequestStatus: { pending: 'pending', draft: 'draft', processing: 'processing', completed: 'completed', cancelled: 'cancelled', ai_generated: 'ai_generated', sent: 'sent', declined: 'declined', needs_manual_handling: 'needs_manual_handling' },
        ProposalStatus: { draft: 'draft', pending_admin_approval: 'pending_admin_approval', sent: 'sent', approved: 'approved', declined: 'declined' },
        SettingCategory: { general: 'general', email: 'email', company: 'company', policies: 'policies' },
        HotelProbeJobStatus: { QUEUED: 'QUEUED', RUNNING: 'RUNNING', PROBING: 'PROBING', COMPLETED: 'COMPLETED', SKIPPED_INSUFFICIENT: 'SKIPPED_INSUFFICIENT', FAILED: 'FAILED' },
        SupplierPriority: { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', AVOID: 'AVOID' },
        BookingFlowStatus: { draft: 'draft', prebooked: 'prebooked', price_changed: 'price_changed', booking: 'booking', booked: 'booked', vouchered: 'vouchered', cancelled: 'cancelled', pending_cancellation: 'pending_cancellation', failed: 'failed' },
    };
});

// ── Service mock ────────────────────────────────────────────────────────────
jest.mock('../services/wbeBooking.service', () => {
    // The real class is kept so `instanceof BookingFlowError` still holds in
    // the controller's error branch — that check is what selects the status.
    const actual = jest.requireActual('../services/wbeBooking.service');
    return {
        ...actual,
        __esModule: true,
        // The controller imports the singleton as a default export.
        default: {
            selectOption: jest.fn(),
            prebook: jest.fn(),
            acceptPriceChange: jest.fn(),
            book: jest.fn(),
            reconcile: jest.fn(),
            syncStatus: jest.fn(),
            issueVoucher: jest.fn(),
            cancel: jest.fn(),
            getById: jest.fn(),
            list: jest.fn(),
            certificationSearch: jest.fn(),
            certificationReport: jest.fn(),
        },
    };
});

// `list`, `get` and `certificationReport` bypass the service and reach the
// repository directly, so mocking the service alone leaves them hitting a real
// Prisma client.
jest.mock('../repositories/booking.repository', () => {
    const actual = jest.requireActual('../repositories/booking.repository');
    return {
        ...actual,
        __esModule: true,
        default: {
            list: jest.fn(),
            findById: jest.fn(),
            listCertificationBookings: jest.fn(),
        },
    };
});

// Only the search call is replaced. The module also exports
// MAX_ROOMS_PER_SEARCH, which bookingSchemas reads at load time — dropping it
// makes every rooms array fail against `.max(undefined)`.
jest.mock('../services/certificationSearch.service', () => {
    const actual = jest.requireActual('../services/certificationSearch.service');
    return {
        ...actual,
        __esModule: true,
        default: { search: jest.fn() },
    };
});

import app from '../app';
import wbeBookingService, { BookingFlowError } from '../services/wbeBooking.service';
import bookingRepository from '../repositories/booking.repository';

const svc = wbeBookingService as jest.Mocked<any>;
const repo = bookingRepository as jest.Mocked<any>;

const TEST_JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-key-for-jest';
const BOOKING_ID = '11111111-2222-4333-8444-555555555555';

/**
 * The booking routes rate-limit to 20 actions per minute per client, and this
 * suite issues more than that. The limiter keys on client IP, so each request
 * presents a distinct forwarded address — that exercises the real limiter
 * rather than disabling it, and keeps the production cap untouched.
 */
let ipCounter = 0;
const nextIp = () => `10.0.${Math.floor(ipCounter / 254)}.${(ipCounter++ % 254) + 1}`;

const authHeader = () => ({
    Authorization: `Bearer ${jwt.sign(
        { id: 'test-user-uuid-1', email: 'agent@test.com' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' },
    )}`,
    'X-Forwarded-For': nextIp(),
});

const aBooking = (over: Record<string, unknown> = {}) => ({
    id: BOOKING_ID,
    status: 'draft',
    agencyReference: 'SETT-ABC123-XYZ789',
    ...over,
});

/** Minimal body that satisfies SelectOptionSchema. */
const selectOptionBody = () => ({
    tid: 'TID-123',
    sessionId: 'SESSION-ABC',
    hotelCode: '1JUTxz7t4A0=',
    hotelName: 'de Russie',
    checkInDate: '2026-10-01',
    checkOutDate: '2026-10-03',
    nights: 2,
    rooms: [
        {
            roomId: 1,
            adultsNo: 2,
            childrenNo: 0,
            passengers: [
                { salutation: 'Mr', firstName: 'John', lastName: 'Doe', isChild: false, isLeader: true },
                { salutation: 'Ms', firstName: 'Jane', lastName: 'Doe', isChild: false },
            ],
        },
    ],
});

beforeEach(() => jest.clearAllMocks());

describe('Booking API', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('authentication', () => {
        const protectedRoutes: Array<[string, string]> = [
            ['post', '/api/v1/bookings'],
            ['get', '/api/v1/bookings'],
            ['get', `/api/v1/bookings/${BOOKING_ID}`],
            ['post', `/api/v1/bookings/${BOOKING_ID}/prebook`],
            ['post', `/api/v1/bookings/${BOOKING_ID}/book`],
            ['post', `/api/v1/bookings/${BOOKING_ID}/cancel`],
            ['post', `/api/v1/bookings/${BOOKING_ID}/voucher`],
            ['post', '/api/v1/bookings/certification/search'],
            ['get', '/api/v1/bookings/certification/report'],
        ];

        it.each(protectedRoutes)('rejects unauthenticated %s %s', async (method, path) => {
            const res = await (request(app) as any)[method](path);
            expect(res.status).toBe(401);
        });

        it('rejects a token signed with the wrong secret', async () => {
            const forged = jwt.sign({ id: 'test-user-uuid-1' }, 'not-the-real-secret');
            const res = await request(app)
                .get('/api/v1/bookings')
                .set({ Authorization: `Bearer ${forged}` });
            expect(res.status).toBe(401);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('POST /api/v1/bookings — select option', () => {
        it('returns 201 and the created booking', async () => {
            svc.selectOption.mockResolvedValue(aBooking());

            const res = await request(app)
                .post('/api/v1/bookings')
                .set(authHeader())
                .send(selectOptionBody());

            expect(res.status).toBe(201);
            expect(res.body.data.id).toBe(BOOKING_ID);
        });

        it('passes the authenticated user through as createdById', async () => {
            svc.selectOption.mockResolvedValue(aBooking());

            await request(app).post('/api/v1/bookings').set(authHeader()).send(selectOptionBody());

            expect(svc.selectOption).toHaveBeenCalledWith(
                expect.objectContaining({ createdById: 'test-user-uuid-1' }),
            );
        });

        it('converts the date strings to Date objects before the service sees them', async () => {
            svc.selectOption.mockResolvedValue(aBooking());

            await request(app).post('/api/v1/bookings').set(authHeader()).send(selectOptionBody());

            const arg = svc.selectOption.mock.calls[0][0];
            expect(arg.checkInDate).toBeInstanceOf(Date);
            expect(arg.checkOutDate).toBeInstanceOf(Date);
        });

        it('rejects a body with no rooms', async () => {
            const res = await request(app)
                .post('/api/v1/bookings')
                .set(authHeader())
                .send({ ...selectOptionBody(), rooms: [] });

            expect(res.status).toBe(400);
            expect(svc.selectOption).not.toHaveBeenCalled();
        });

        it('rejects a room whose passengers contradict its occupancy', async () => {
            const body = selectOptionBody();
            body.rooms[0]!.adultsNo = 3; // manifest still carries two

            const res = await request(app).post('/api/v1/bookings').set(authHeader()).send(body);

            expect(res.status).toBe(400);
            expect(svc.selectOption).not.toHaveBeenCalled();
        });

        it('rejects a child passenger with no age', async () => {
            const body = selectOptionBody();
            body.rooms[0] = {
                roomId: 1,
                adultsNo: 1,
                childrenNo: 1,
                passengers: [
                    { salutation: 'Mr', firstName: 'John', lastName: 'Doe', isChild: false },
                    { salutation: 'Chd', firstName: 'Amy', lastName: 'Doe', isChild: true } as any,
                ],
            } as any;

            const res = await request(app).post('/api/v1/bookings').set(authHeader()).send(body);

            expect(res.status).toBe(400);
            expect(svc.selectOption).not.toHaveBeenCalled();
        });

        it('rejects a missing tid', async () => {
            const { tid, ...withoutTid } = selectOptionBody();
            const res = await request(app).post('/api/v1/bookings').set(authHeader()).send(withoutTid);
            expect(res.status).toBe(400);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('BookingFlowError → HTTP status mapping', () => {
        // The frontend branches on these; an incorrect mapping would surface as
        // a retry loop or a swallowed error rather than a visible failure.
        const cases: Array<[string, number]> = [
            ['NOT_FOUND', 404],
            ['PASSENGER_MISMATCH', 400],
            ['ALREADY_PREBOOKED', 409],
            ['INVALID_STATE', 409],
            ['PRICE_CHANGE_UNACCEPTED', 409],
            ['AMBIGUOUS_BOOKING', 409],
            ['WBE_REJECTED', 502],
        ];

        it.each(cases)('maps %s to %i', async (code, status) => {
            svc.prebook.mockRejectedValue(new BookingFlowError(`failing with ${code}`, code as any));

            const res = await request(app)
                .post(`/api/v1/bookings/${BOOKING_ID}/prebook`)
                .set(authHeader());

            expect(res.status).toBe(status);
        });

        it('does not leak a non-flow error as a 2xx', async () => {
            svc.book.mockRejectedValue(new Error('unexpected'));

            const res = await request(app)
                .post(`/api/v1/bookings/${BOOKING_ID}/book`)
                .set(authHeader());

            expect(res.status).toBeGreaterThanOrEqual(500);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('POST /:id/prebook', () => {
        it('returns 200 on success', async () => {
            svc.prebook.mockResolvedValue(aBooking({ status: 'prebooked' }));

            const res = await request(app)
                .post(`/api/v1/bookings/${BOOKING_ID}/prebook`)
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(svc.prebook).toHaveBeenCalledWith(BOOKING_ID);
        });

        it('flags a price change in the response message', async () => {
            svc.prebook.mockResolvedValue(aBooking({ status: 'price_changed' }));

            const res = await request(app)
                .post(`/api/v1/bookings/${BOOKING_ID}/prebook`)
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(res.body.message).toMatch(/price changed/i);
        });

        it('rejects a non-UUID booking id', async () => {
            const res = await request(app).post('/api/v1/bookings/not-a-uuid/prebook').set(authHeader());
            expect(res.status).toBe(400);
            expect(svc.prebook).not.toHaveBeenCalled();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('lifecycle endpoints', () => {
        const lifecycle: Array<[string, string]> = [
            ['book', 'book'],
            ['cancel', 'cancel'],
            ['voucher', 'issueVoucher'],
            ['sync', 'syncStatus'],
        ];

        it.each(lifecycle)('POST /:id/%s returns 200 and delegates to the service', async (path, method) => {
            svc[method].mockResolvedValue(aBooking({ status: 'confirmed' }));

            const res = await request(app)
                .post(`/api/v1/bookings/${BOOKING_ID}/${path}`)
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(svc[method]).toHaveBeenCalled();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('GET /api/v1/bookings', () => {
        it('returns the list with pagination metadata', async () => {
            repo.list.mockResolvedValue({ items: [aBooking()], total: 1 });

            const res = await request(app).get('/api/v1/bookings').set(authHeader());

            expect(res.status).toBe(200);
            expect(repo.list).toHaveBeenCalled();
            expect(res.body.data.pagination).toEqual(
                expect.objectContaining({ total: 1, totalPages: 1 }),
            );
        });

        it('rejects a non-numeric page', async () => {
            const res = await request(app).get('/api/v1/bookings?page=abc').set(authHeader());
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/v1/bookings/:id', () => {
        it('returns the booking', async () => {
            repo.findById.mockResolvedValue(aBooking());

            const res = await request(app).get(`/api/v1/bookings/${BOOKING_ID}`).set(authHeader());

            expect(res.status).toBe(200);
            expect(res.body.data.id).toBe(BOOKING_ID);
        });

        it('returns 404 when the booking does not exist', async () => {
            // The repository resolves null rather than throwing, so the 404 has
            // to come from the handler's own guard.
            repo.findById.mockResolvedValue(null);

            const res = await request(app).get(`/api/v1/bookings/${BOOKING_ID}`).set(authHeader());

            expect(res.status).toBe(404);
        });

        it('rejects a non-UUID id', async () => {
            const res = await request(app).get('/api/v1/bookings/12345').set(authHeader());
            expect(res.status).toBe(400);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('certification routes', () => {
        // These literal paths are declared before `/:id`; if that order is ever
        // reversed they would be captured by the UUID param route and 400.
        it('GET /certification/report is not captured by the /:id route', async () => {
            repo.listCertificationBookings.mockResolvedValue([]);

            const res = await request(app)
                .get('/api/v1/bookings/certification/report')
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(repo.listCertificationBookings).toHaveBeenCalled();
            // Had `/:id` won the match, this is the call that would have fired.
            expect(repo.findById).not.toHaveBeenCalled();
        });

        it('POST /certification/search validates its body', async () => {
            const res = await request(app)
                .post('/api/v1/bookings/certification/search')
                .set(authHeader())
                .send({});

            expect(res.status).toBe(400);
            expect(svc.certificationSearch).not.toHaveBeenCalled();
        });
    });
});
