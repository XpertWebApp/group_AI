/**
 * API-level tests for the group booking endpoints.
 *
 * The distinction these guard is the one a caller cannot recover on its own:
 * a group that booked every room and a group that booked most of them are
 * different outcomes, and the HTTP status has to say which. Reporting a
 * shortfall as a plain 201 is how a customer ends up short without anyone
 * noticing.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';

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
        JobStatus: { IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', FAILED: 'FAILED' },
        BookingRequestStatus: { pending: 'pending', draft: 'draft', processing: 'processing', completed: 'completed', cancelled: 'cancelled', ai_generated: 'ai_generated', sent: 'sent', declined: 'declined', needs_manual_handling: 'needs_manual_handling' },
        ProposalStatus: { draft: 'draft', pending_admin_approval: 'pending_admin_approval', sent: 'sent', approved: 'approved', declined: 'declined' },
        SettingCategory: { general: 'general', email: 'email', company: 'company', policies: 'policies' },
        HotelProbeJobStatus: { QUEUED: 'QUEUED', RUNNING: 'RUNNING', PROBING: 'PROBING', COMPLETED: 'COMPLETED', SKIPPED_INSUFFICIENT: 'SKIPPED_INSUFFICIENT', FAILED: 'FAILED' },
        SupplierPriority: { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', AVOID: 'AVOID' },
        BookingFlowStatus: { draft: 'draft', prebooked: 'prebooked', price_changed: 'price_changed', booking: 'booking', booked: 'booked', vouchered: 'vouchered', cancelled: 'cancelled', pending_cancellation: 'pending_cancellation', failed: 'failed' },
        BookingGroupStatus: { pending: 'pending', booking: 'booking', confirmed: 'confirmed', partial: 'partial', failed: 'failed', cancelled: 'cancelled' },
    };
});

jest.mock('../services/groupBooking.service', () => {
    // The real error class is kept so `instanceof` still holds in the
    // controller's error branch — that check is what selects the status.
    const actual = jest.requireActual('../services/groupBooking.service');
    return {
        ...actual,
        __esModule: true,
        default: { bookGroup: jest.fn(), cancelGroup: jest.fn(), voucherGroup: jest.fn() },
    };
});

// The voucher endpoint is gated on the handler's review, so the gate has to be
// controllable from here — the real error class is kept so `instanceof` still
// selects the right status in the controller.
jest.mock('../services/groupReview.service', () => {
    const actual = jest.requireActual('../services/groupReview.service');
    return {
        ...actual,
        __esModule: true,
        default: { assertReviewed: jest.fn(), buildReviewSheet: jest.fn() },
    };
});

jest.mock('../repositories/bookingGroup.repository', () => {
    const actual = jest.requireActual('../repositories/bookingGroup.repository');
    return {
        ...actual,
        __esModule: true,
        default: {
            list: jest.fn(),
            findById: jest.fn(),
            findPartial: jest.fn(),
            findByRequest: jest.fn(),
        },
    };
});

import app from '../app';
import groupBookingService, { GroupBookingError } from '../services/groupBooking.service';
import bookingGroupRepository from '../repositories/bookingGroup.repository';
import groupReviewService, { GroupReviewError } from '../services/groupReview.service';

const svc = groupBookingService as jest.Mocked<any>;
const repo = bookingGroupRepository as jest.Mocked<any>;
const review = groupReviewService as jest.Mocked<any>;

const TEST_JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-key-for-jest';
const GROUP_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = '99999999-8888-4777-8666-555555555555';

/**
 * The routes rate-limit to ten calls a minute per client and this suite issues
 * more, so each request presents a distinct forwarded address. That exercises
 * the real limiter rather than disabling it, and leaves the production cap
 * untouched.
 */
let ipCounter = 0;
const nextIp = () => `10.1.${Math.floor(ipCounter / 254)}.${(ipCounter++ % 254) + 1}`;

const authHeader = () => ({
    Authorization: `Bearer ${jwt.sign(
        { id: 'test-user-uuid-1', email: 'agent@test.com' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' },
    )}`,
    'X-Forwarded-For': nextIp(),
});

const aGroup = (over: Record<string, unknown> = {}) => ({
    id: GROUP_ID,
    groupReference: 'SETTG-ABC123-XYZ789',
    status: 'confirmed',
    roomsRequested: 4,
    roomsConfirmed: 4,
    shortfallNote: null,
    bookings: [],
    ...over,
});

const adult = () => ({
    salutation: 'Mr',
    firstName: 'John',
    lastName: 'Doe',
    isChild: false,
});

const body = (rooms = 2) => ({
    requestId: REQUEST_ID,
    hotelCode: 'HOTEL-1',
    hotelName: 'Test Hotel',
    checkInDate: '2026-10-01',
    nights: 3,
    roomsRequested: rooms,
    currency: 'EUR',
    rooms: Array.from({ length: rooms }, (_, i) => ({
        roomId: i + 1,
        adultsNo: 1,
        childrenNo: 0,
        passengers: [adult()],
    })),
});

beforeEach(() => jest.clearAllMocks());

describe('Booking group API', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('authentication', () => {
        const routes: Array<[string, string]> = [
            ['post', '/api/v1/booking-groups'],
            ['get', '/api/v1/booking-groups'],
            ['get', `/api/v1/booking-groups/${GROUP_ID}`],
            ['post', `/api/v1/booking-groups/${GROUP_ID}/cancel`],
            ['get', '/api/v1/booking-groups/partial'],
            ['get', `/api/v1/booking-groups/by-request/${REQUEST_ID}`],
        ];

        it.each(routes)('rejects unauthenticated %s %s', async (method, path) => {
            const res = await (request(app) as any)[method](path);
            expect(res.status).toBe(401);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('POST /api/v1/booking-groups', () => {
        it('returns 201 when every room was confirmed', async () => {
            svc.bookGroup.mockResolvedValue(aGroup({ roomsRequested: 2, roomsConfirmed: 2 }));

            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send(body());

            expect(res.status).toBe(201);
        });

        it('returns 207 when only some rooms were confirmed', async () => {
            // The distinction this endpoint exists to make: a shortfall must
            // not be reported as an unqualified success.
            svc.bookGroup.mockResolvedValue(
                aGroup({
                    status: 'partial',
                    roomsRequested: 2,
                    roomsConfirmed: 1,
                    shortfallNote: '1 room(s) short. HBA: no availability',
                }),
            );

            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send(body());

            expect(res.status).toBe(207);
        });

        it('names the shortfall in the response message', async () => {
            svc.bookGroup.mockResolvedValue(
                aGroup({
                    status: 'partial',
                    roomsRequested: 2,
                    roomsConfirmed: 1,
                    shortfallNote: '1 room(s) short. HBA: no availability',
                }),
            );

            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send(body());

            expect(res.body.message).toMatch(/1 of 2/);
            expect(res.body.message).toMatch(/HBA/);
        });

        it('passes the authenticated user through as createdById', async () => {
            svc.bookGroup.mockResolvedValue(aGroup({ roomsRequested: 2, roomsConfirmed: 2 }));

            await request(app).post('/api/v1/booking-groups').set(authHeader()).send(body());

            expect(svc.bookGroup).toHaveBeenCalledWith(
                expect.objectContaining({ createdById: 'test-user-uuid-1' }),
            );
        });

        it('converts checkInDate to a Date before the service sees it', async () => {
            svc.bookGroup.mockResolvedValue(aGroup({ roomsRequested: 2, roomsConfirmed: 2 }));

            await request(app).post('/api/v1/booking-groups').set(authHeader()).send(body());

            expect(svc.bookGroup.mock.calls[0][0].checkInDate).toBeInstanceOf(Date);
        });

        it('rejects a manifest that does not cover every room being booked', async () => {
            // Booking a different group from the one quoted is worse than
            // refusing, so the mismatch is caught before the service runs.
            const payload = { ...body(2), roomsRequested: 5 };

            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send(payload);

            expect(res.status).toBe(400);
            expect(svc.bookGroup).not.toHaveBeenCalled();
        });

        it('rejects a request with no rooms', async () => {
            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send({ ...body(), rooms: [], roomsRequested: 0 });

            expect(res.status).toBe(400);
        });

        it('rejects a non-UUID requestId', async () => {
            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send({ ...body(), requestId: 'not-a-uuid' });

            expect(res.status).toBe(400);
        });

        it('rejects a room whose passengers contradict its occupancy', async () => {
            const payload = body(2);
            payload.rooms[0]!.adultsNo = 3;

            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send(payload);

            expect(res.status).toBe(400);
        });

        it('defaults acceptPriceDrift to false rather than assuming consent', async () => {
            svc.bookGroup.mockResolvedValue(aGroup({ roomsRequested: 2, roomsConfirmed: 2 }));

            await request(app).post('/api/v1/booking-groups').set(authHeader()).send(body());

            expect(svc.bookGroup).toHaveBeenCalledWith(
                expect.objectContaining({ acceptPriceDrift: false }),
            );
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('GroupBookingError → HTTP status', () => {
        const cases: Array<[string, number]> = [
            ['PROPOSAL_NOT_BOOKABLE', 404],
            ['NO_AVAILABILITY', 409],
            ['PRICE_DRIFT_EXCEEDED', 409],
            ['TOO_MANY_SLICES', 409],
            ['ALREADY_BOOKED', 409],
        ];

        it.each(cases)('maps %s to %i', async (code, status) => {
            svc.bookGroup.mockRejectedValue(new GroupBookingError(`failing ${code}`, code as any));

            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send(body());

            expect(res.status).toBe(status);
        });

        it('does not report an unexpected error as a success', async () => {
            svc.bookGroup.mockRejectedValue(new Error('unexpected'));

            const res = await request(app)
                .post('/api/v1/booking-groups')
                .set(authHeader())
                .send(body());

            expect(res.status).toBeGreaterThanOrEqual(500);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('GET /api/v1/booking-groups', () => {
        it('returns the list with pagination metadata', async () => {
            repo.list.mockResolvedValue({ items: [aGroup()], total: 1 });

            const res = await request(app).get('/api/v1/booking-groups').set(authHeader());

            expect(res.status).toBe(200);
            expect(res.body.data.pagination).toEqual(
                expect.objectContaining({ total: 1, totalPages: 1 }),
            );
        });

        it('rejects an unknown status filter', async () => {
            const res = await request(app)
                .get('/api/v1/booking-groups?status=nonsense')
                .set(authHeader());

            expect(res.status).toBe(400);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('GET /api/v1/booking-groups/partial', () => {
        it('is not captured by the /:id route', async () => {
            repo.findPartial.mockResolvedValue([]);

            const res = await request(app)
                .get('/api/v1/booking-groups/partial')
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(repo.findPartial).toHaveBeenCalled();
            expect(repo.findById).not.toHaveBeenCalled();
        });

        it('reports the shortfall for each group needing attention', async () => {
            repo.findPartial.mockResolvedValue([
                aGroup({
                    status: 'partial',
                    roomsRequested: 10,
                    roomsConfirmed: 6,
                    shortfallNote: '4 room(s) short. HBA: no availability',
                }),
            ]);

            const res = await request(app)
                .get('/api/v1/booking-groups/partial')
                .set(authHeader());

            expect(res.body.data[0]).toEqual(
                expect.objectContaining({ shortfall: 4, roomsConfirmed: 6 }),
            );
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('GET /api/v1/booking-groups/:id', () => {
        it('returns the group', async () => {
            repo.findById.mockResolvedValue(aGroup());

            const res = await request(app)
                .get(`/api/v1/booking-groups/${GROUP_ID}`)
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(res.body.data.id).toBe(GROUP_ID);
        });

        it('returns 404 when the group does not exist', async () => {
            repo.findById.mockResolvedValue(null);

            const res = await request(app)
                .get(`/api/v1/booking-groups/${GROUP_ID}`)
                .set(authHeader());

            expect(res.status).toBe(404);
        });

        it('rejects a non-UUID id', async () => {
            const res = await request(app).get('/api/v1/booking-groups/12345').set(authHeader());
            expect(res.status).toBe(400);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('POST /api/v1/booking-groups/:id/voucher', () => {
        beforeEach(() => {
            review.assertReviewed.mockResolvedValue(undefined);
            svc.voucherGroup.mockResolvedValue({
                group: aGroup(),
                vouchered: ['WRW111', 'WRW222'],
                failed: [],
            });
        });

        it('rejects an unauthenticated request', async () => {
            const res = await request(app).post(`/api/v1/booking-groups/${GROUP_ID}/voucher`);
            expect(res.status).toBe(401);
        });

        it('returns 200 when every reservation was vouchered', async () => {
            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/voucher`)
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(res.body.data.vouchered).toHaveLength(2);
        });

        it('returns 207 when some reservations could not be vouchered', async () => {
            // An unvouchered booking is cancelled by WBE at its deadline, so a
            // partial result needs someone to finish it — not a plain success.
            svc.voucherGroup.mockResolvedValue({
                group: aGroup(),
                vouchered: ['WRW111'],
                failed: [{ bookingReference: 'WRW222', reason: 'supplier refused' }],
            });

            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/voucher`)
                .set(authHeader());

            expect(res.status).toBe(207);
        });

        it('names the reservations still needing a voucher', async () => {
            svc.voucherGroup.mockResolvedValue({
                group: aGroup(),
                vouchered: [],
                failed: [{ bookingReference: 'WRW222', reason: 'supplier refused' }],
            });

            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/voucher`)
                .set(authHeader());

            expect(res.body.message).toContain('WRW222');
            expect(res.body.message).toMatch(/cancelled at its deadline/);
        });

        it('refuses to voucher a booking the handler has not reviewed', async () => {
            // Vouchering commits the group; the client's process puts a human
            // check before that point.
            review.assertReviewed.mockRejectedValue(
                new GroupReviewError('Not reviewed', 'NOT_REVIEWED'),
            );

            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/voucher`)
                .set(authHeader());

            expect(res.status).toBe(409);
            expect(svc.voucherGroup).not.toHaveBeenCalled();
        });

        it('refuses to voucher a booking that was rejected at review', async () => {
            review.assertReviewed.mockRejectedValue(
                new GroupReviewError('Rejected: wrong hotel', 'REVIEW_REJECTED'),
            );

            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/voucher`)
                .set(authHeader());

            expect(res.status).toBe(409);
        });

        it('rejects a non-UUID group id', async () => {
            const res = await request(app)
                .post('/api/v1/booking-groups/not-a-uuid/voucher')
                .set(authHeader());

            expect(res.status).toBe(400);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('POST /api/v1/booking-groups/:id/cancel', () => {
        it('returns 200 once every slice has been attempted', async () => {
            svc.cancelGroup.mockResolvedValue(aGroup({ status: 'cancelled' }));

            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/cancel`)
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(svc.cancelGroup).toHaveBeenCalledWith(GROUP_ID);
        });

        it('still returns 200 when a cancellation has not settled', async () => {
            // Every slice was attempted; the status carries what happened,
            // which is more useful than an error hiding the ones that worked.
            svc.cancelGroup.mockResolvedValue(aGroup({ status: 'partial' }));

            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/cancel`)
                .set(authHeader());

            expect(res.status).toBe(200);
            expect(res.body.message).toMatch(/not yet settled/);
        });

        it('returns 404 for a group that does not exist', async () => {
            svc.cancelGroup.mockRejectedValue(
                new GroupBookingError('Group not found', 'PROPOSAL_NOT_BOOKABLE'),
            );

            const res = await request(app)
                .post(`/api/v1/booking-groups/${GROUP_ID}/cancel`)
                .set(authHeader());

            expect(res.status).toBe(404);
        });
    });
});
