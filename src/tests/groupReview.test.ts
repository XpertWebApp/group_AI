/**
 * Unit tests for the group handler review.
 *
 * The gate these protect is the client's, stated plainly: "The customer-facing
 * offer must not be sent before this review is completed." A regression here
 * does not throw — it lets an unchecked booking reach a customer, which is
 * exactly the outcome the review exists to prevent.
 *
 * The other thing under test is honesty about what was checked. Items only a
 * person can judge are reported as `manual` rather than passed, so a handler
 * cannot mistake the sheet for a machine approval.
 */
jest.mock('@prisma/client', () => {
    const mPrisma = {
        bookingGroup: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
        },
        bookingRequest: { findUnique: jest.fn() },
    };
    return {
        PrismaClient: jest.fn(() => mPrisma),
        Prisma: { DbNull: null, JsonNull: null },
        BookingGroupStatus: {
            pending: 'pending',
            booking: 'booking',
            confirmed: 'confirmed',
            partial: 'partial',
            failed: 'failed',
            cancelled: 'cancelled',
        },
        BookingFlowStatus: {
            draft: 'draft',
            prebooked: 'prebooked',
            price_changed: 'price_changed',
            booking: 'booking',
            booked: 'booked',
            vouchered: 'vouchered',
            cancelled: 'cancelled',
            pending_cancellation: 'pending_cancellation',
            failed: 'failed',
        },
    };
});

import { PrismaClient } from '@prisma/client';
import service, { GroupReviewError, type ReviewCheck } from '../services/groupReview.service';

const prisma = new (PrismaClient as any)() as any;

// ── Fixtures ────────────────────────────────────────────────────────────────

const GROUP_ID = '11111111-2222-4333-8444-555555555555';
const REVIEWER = 'user-1';

/** A future date, so the dates check does not fire on unrelated tests. */
const soon = (days = 45) => new Date(Date.now() + days * 86_400_000);

const aBooking = (over: Record<string, unknown> = {}) => ({
    id: 'booking-1',
    status: 'booked',
    bookingReference: 'WRW123456789',
    nonRefundable: false,
    cancellationDeadline: soon(30),
    ...over,
});

const aGroup = (over: Record<string, unknown> = {}) => ({
    id: GROUP_ID,
    groupReference: 'SETTG-TEST',
    status: 'confirmed',
    hotelCode: 'HOTEL-1',
    hotelName: 'Test Hotel',
    checkInDate: soon(45),
    checkOutDate: soon(48),
    nights: 3,
    roomsRequested: 7,
    roomsConfirmed: 7,
    quotedTotal: 14400,
    totalBooked: 12000,
    currency: 'EUR',
    shortfallNote: null,
    requestId: 'request-1',
    reviewedAt: null,
    reviewedById: null,
    reviewNotes: null,
    reviewRejectedAt: null,
    reviewRejectionReason: null,
    bookings: [aBooking()],
    proposal: { paymentDeadline: soon(20), hotels: [] },
    request: {},
    reviewedBy: null,
    ...over,
});

/** Find one check on the sheet by its key. */
const check = (sheet: { checks: ReviewCheck[] }, key: string): ReviewCheck =>
    sheet.checks.find((c) => c.key === key)!;

beforeEach(() => {
    jest.clearAllMocks();
    prisma.bookingGroup.findUnique.mockResolvedValue(aGroup());
    prisma.bookingGroup.update.mockResolvedValue({});
    prisma.bookingRequest.findUnique.mockResolvedValue({ odooContactId: 43121 });
});

describe('Group handler review', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('the review sheet', () => {
        it('covers every item the client listed', async () => {
            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(sheet.checks.map((c) => c.key).sort()).toEqual(
                [
                    'booking_status',
                    'cancellation',
                    'dates',
                    'hotel',
                    'margin',
                    'odoo_order',
                    'payment',
                    'rates',
                    'rooms',
                    'supplier_references',
                ].sort(),
            );
        });

        it('leaves the hotel choice for a person to judge', async () => {
            // No system can say whether this is the hotel the customer wanted.
            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'hotel').status).toBe('manual');
        });

        it('passes a fully confirmed group', async () => {
            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'rooms').status).toBe('ok');
            expect(check(sheet, 'booking_status').status).toBe('ok');
        });

        it('flags a group that is short of rooms', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ roomsConfirmed: 4, status: 'partial', shortfallNote: '3 short. HBA refused.' }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'rooms').status).toBe('attention');
            expect(check(sheet, 'rooms').note).toMatch(/3 room\(s\) short/);
        });

        it('flags a check-in date that has already passed', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ checkInDate: new Date('2020-01-01') }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'dates').status).toBe('attention');
        });

        it('reports the margin the handler has to check', async () => {
            const sheet = await service.buildReviewSheet(GROUP_ID);
            // 14400 sold against 12000 bought.
            expect(check(sheet, 'margin').value).toMatch(/2400/);
            expect(check(sheet, 'margin').status).toBe('ok');
        });

        it('flags a booking being sold below cost', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ quotedTotal: 10000, totalBooked: 12000 }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'margin').status).toBe('attention');
            expect(check(sheet, 'margin').note).toMatch(/below cost/);
        });

        it('flags a margin that cannot be calculated', async () => {
            // Reporting an uncomputable margin as fine would show the whole
            // sale as profit.
            prisma.bookingGroup.findUnique.mockResolvedValue(aGroup({ totalBooked: null }));

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'margin').status).toBe('attention');
            expect(check(sheet, 'rates').status).toBe('attention');
        });

        it('lists the supplier references the booking produced', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({
                    bookings: [
                        aBooking({ bookingReference: 'WRW111' }),
                        aBooking({ id: 'booking-2', bookingReference: 'WRW222' }),
                    ],
                }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'supplier_references').value).toContain('WRW111');
            expect(check(sheet, 'supplier_references').value).toContain('WRW222');
        });

        it('flags a group with no confirmed reservation', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ bookings: [aBooking({ status: 'failed' })] }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'supplier_references').status).toBe('attention');
        });

        it('reports a non-refundable reservation in the cancellation terms', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ bookings: [aBooking({ nonRefundable: true })] }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'cancellation').value).toMatch(/non-refundable/i);
        });

        it('reports the earliest deadline across the group', async () => {
            // The earliest governs the whole booking: past it, part of the
            // group can no longer be cancelled free.
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({
                    bookings: [
                        aBooking({ cancellationDeadline: new Date('2026-10-20') }),
                        aBooking({ id: 'b2', cancellationDeadline: new Date('2026-10-05') }),
                    ],
                }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'cancellation').value).toContain('2026-10-05');
        });

        it('flags a missing payment deadline', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ proposal: { paymentDeadline: null, hotels: [] } }),
            );

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'payment').status).toBe('attention');
        });

        it('flags a request with no Odoo customer', async () => {
            prisma.bookingRequest.findUnique.mockResolvedValue({ odooContactId: null });

            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'odoo_order').status).toBe('attention');
        });

        it('does not claim the Odoo order is complete', async () => {
            // Completeness is checked in Odoo, not from here.
            const sheet = await service.buildReviewSheet(GROUP_ID);
            expect(check(sheet, 'odoo_order').status).toBe('manual');
        });

        it('reports no issues only when nothing is flagged', async () => {
            const clean = await service.buildReviewSheet(GROUP_ID);
            expect(clean.noIssuesFound).toBe(true);

            prisma.bookingGroup.findUnique.mockResolvedValue(aGroup({ roomsConfirmed: 4 }));
            const flagged = await service.buildReviewSheet(GROUP_ID);
            expect(flagged.noIssuesFound).toBe(false);
        });

        it('refuses a group that does not exist', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(null);

            await expect(service.buildReviewSheet(GROUP_ID)).rejects.toMatchObject({
                code: 'GROUP_NOT_FOUND',
            });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('approving', () => {
        it('records who approved and when', async () => {
            await service.approve(GROUP_ID, REVIEWER, 'Checked against the Odoo order.');

            expect(prisma.bookingGroup.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reviewedById: REVIEWER,
                        reviewNotes: 'Checked against the Odoo order.',
                        reviewedAt: expect.any(Date),
                    }),
                }),
            );
        });

        it('allows approval despite a flagged check', async () => {
            // A group short two rooms may still be the right thing to offer.
            // Refusing here would push the decision outside the system, where
            // nothing records it.
            prisma.bookingGroup.findUnique.mockResolvedValue(aGroup({ roomsConfirmed: 5 }));

            await expect(service.approve(GROUP_ID, REVIEWER)).resolves.toBeDefined();
        });

        it('refuses to approve a group holding no rooms', async () => {
            // Approving would clear an offer that cannot be honoured.
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ roomsConfirmed: 0, status: 'failed' }),
            );

            await expect(service.approve(GROUP_ID, REVIEWER)).rejects.toMatchObject({
                code: 'NOT_BOOKED',
            });
        });

        it('refuses a second approval', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ reviewedAt: new Date('2026-08-01') }),
            );

            await expect(service.approve(GROUP_ID, REVIEWER)).rejects.toMatchObject({
                code: 'ALREADY_REVIEWED',
            });
        });

        it('clears an earlier rejection', async () => {
            // Leaving both stamped would make the record contradict itself.
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ reviewRejectedAt: new Date('2026-08-01'), reviewRejectionReason: 'Wrong hotel' }),
            );

            await service.approve(GROUP_ID, REVIEWER);

            expect(prisma.bookingGroup.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reviewRejectedAt: null,
                        reviewRejectionReason: null,
                    }),
                }),
            );
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('rejecting', () => {
        it('records the reason and who rejected', async () => {
            await service.reject(GROUP_ID, REVIEWER, 'Margin does not hold at this rate.');

            expect(prisma.bookingGroup.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reviewRejectionReason: 'Margin does not hold at this rate.',
                        reviewedById: REVIEWER,
                    }),
                }),
            );
        });

        it('leaves the group unapproved', async () => {
            await service.reject(GROUP_ID, REVIEWER, 'Wrong hotel selected.');

            expect(prisma.bookingGroup.update).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ reviewedAt: null }) }),
            );
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the gate that holds the offer', () => {
        it('blocks an unreviewed booking', async () => {
            // The client's requirement in one assertion.
            await expect(service.assertReviewed(GROUP_ID)).rejects.toMatchObject({
                code: 'NOT_REVIEWED',
            });
        });

        it('opens once a handler has approved', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({ reviewedAt: new Date(), reviewRejectedAt: null }),
            );

            await expect(service.assertReviewed(GROUP_ID)).resolves.toBeUndefined();
        });

        it('stays shut on a rejected booking', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({
                    reviewedAt: null,
                    reviewRejectedAt: new Date(),
                    reviewRejectionReason: 'Margin does not hold.',
                }),
            );

            await expect(service.assertReviewed(GROUP_ID)).rejects.toMatchObject({
                code: 'REVIEW_REJECTED',
            });
        });

        it('names the rejection reason so it can be acted on', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(
                aGroup({
                    reviewedAt: null,
                    reviewRejectedAt: new Date(),
                    reviewRejectionReason: 'Margin does not hold.',
                }),
            );

            await expect(service.assertReviewed(GROUP_ID)).rejects.toThrow(/Margin does not hold/);
        });

        it('refuses a group that does not exist', async () => {
            prisma.bookingGroup.findUnique.mockResolvedValue(null);

            await expect(service.assertReviewed(GROUP_ID)).rejects.toMatchObject({
                code: 'GROUP_NOT_FOUND',
            });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the gate applied to a whole proposal', () => {
        it('lets a proposal with no bookings through', async () => {
            // An offer sent before anything is booked is the ordinary flow and
            // not what the review exists for.
            prisma.bookingGroup.findMany.mockResolvedValue([]);

            await expect(service.assertProposalReviewed('proposal-1')).resolves.toBeUndefined();
        });

        it('blocks when any booking on it is unreviewed', async () => {
            prisma.bookingGroup.findMany.mockResolvedValue([{ id: GROUP_ID }]);
            prisma.bookingGroup.findUnique.mockResolvedValue(aGroup({ reviewedAt: null }));

            await expect(service.assertProposalReviewed('proposal-1')).rejects.toMatchObject({
                code: 'NOT_REVIEWED',
            });
        });

        it('lets it through once every booking is approved', async () => {
            prisma.bookingGroup.findMany.mockResolvedValue([{ id: GROUP_ID }]);
            prisma.bookingGroup.findUnique.mockResolvedValue(aGroup({ reviewedAt: new Date() }));

            await expect(service.assertProposalReviewed('proposal-1')).resolves.toBeUndefined();
        });

        it('only considers bookings that hold rooms', async () => {
            prisma.bookingGroup.findMany.mockResolvedValue([]);

            await service.assertProposalReviewed('proposal-1');

            expect(prisma.bookingGroup.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ roomsConfirmed: { gt: 0 } }),
                }),
            );
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the handler worklist', () => {
        it('asks only for groups nobody has looked at yet', async () => {
            prisma.bookingGroup.findMany.mockResolvedValue([]);

            await service.findAwaitingReview();

            expect(prisma.bookingGroup.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        reviewedAt: null,
                        reviewRejectedAt: null,
                        roomsConfirmed: { gt: 0 },
                    }),
                }),
            );
        });

        it('lists the oldest first, so nothing is left waiting', async () => {
            prisma.bookingGroup.findMany.mockResolvedValue([]);

            await service.findAwaitingReview();

            expect(prisma.bookingGroup.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
            );
        });
    });
});
