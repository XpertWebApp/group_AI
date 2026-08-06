import { PrismaClient, BookingGroupStatus, BookingFlowStatus } from '@prisma/client';

import bookingGroupRepository from '../repositories/bookingGroup.repository';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * The group handler's review of a completed booking.
 *
 * The client requires a person to check a booking before the customer-facing
 * offer goes out, and states the gate plainly: "The customer-facing offer must
 * not be sent before this review is completed."
 *
 * The review is a human judgement, not something this service can make. What it
 * does is assemble everything the handler has to look at into one view, flag the
 * things that are checkable from data, and refuse to let an offer past until
 * someone has signed off.
 */

export class GroupReviewError extends Error {
    constructor(
        message: string,
        readonly code:
            | 'GROUP_NOT_FOUND'
            | 'NOT_BOOKED'
            | 'ALREADY_REVIEWED'
            | 'NOT_REVIEWED'
            | 'REVIEW_REJECTED',
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'GroupReviewError';
    }
}

/** One thing the handler has to check, with whatever the data already says. */
export interface ReviewCheck {
    key: string;
    label: string;
    /** What the system found. Null where only a person can judge it. */
    value: string | null;
    /**
     * `ok` — checkable from data and consistent.
     * `attention` — checkable and something looks wrong.
     * `manual` — the handler has to decide; the system cannot.
     */
    status: 'ok' | 'attention' | 'manual';
    note?: string;
}

export interface ReviewSheet {
    groupId: string;
    groupReference: string;
    status: BookingGroupStatus;
    reviewedAt: Date | null;
    reviewedBy: string | null;
    reviewNotes: string | null;
    rejectedAt: Date | null;
    rejectionReason: string | null;
    checks: ReviewCheck[];
    /** True when nothing checkable is flagged. Not the same as approved. */
    noIssuesFound: boolean;
}

export class GroupReviewService {
    /**
     * Build the sheet the handler works from.
     *
     * Every item the client listed appears, including the ones no system can
     * verify — a hotel being the right hotel is a judgement. Those are marked
     * `manual` rather than quietly passed, so the sheet cannot be mistaken for
     * a machine approval.
     */
    async buildReviewSheet(groupId: string): Promise<ReviewSheet> {
        const group = await prisma.bookingGroup.findUnique({
            where: { id: groupId },
            include: {
                bookings: { orderBy: { createdAt: 'asc' } },
                proposal: { include: { hotels: { where: { deletedAt: null } } } },
                request: true,
                reviewedBy: { select: { email: true } },
            },
        });

        if (!group) throw new GroupReviewError('Booking group not found', 'GROUP_NOT_FOUND');

        const confirmed = group.bookings.filter(
            (b) =>
                b.status === BookingFlowStatus.booked ||
                b.status === BookingFlowStatus.vouchered,
        );

        const checks: ReviewCheck[] = [
            {
                key: 'hotel',
                label: 'Selected hotel and option',
                value: group.hotelName ?? group.hotelCode,
                // Whether this is the hotel the customer wanted is not something
                // the data can answer.
                status: 'manual',
            },
            {
                key: 'booking_status',
                label: 'Availability and booking status',
                value: group.status,
                status: group.status === BookingGroupStatus.confirmed ? 'ok' : 'attention',
                note:
                    group.status === BookingGroupStatus.partial
                        ? (group.shortfallNote ?? 'Some rooms are not held.')
                        : undefined,
            },
            {
                key: 'rooms',
                label: 'Room quantities and room types',
                value: `${group.roomsConfirmed} of ${group.roomsRequested} rooms confirmed`,
                status: group.roomsConfirmed >= group.roomsRequested ? 'ok' : 'attention',
                note:
                    group.roomsConfirmed < group.roomsRequested
                        ? `${group.roomsRequested - group.roomsConfirmed} room(s) short.`
                        : undefined,
            },
            {
                key: 'dates',
                label: 'Dates',
                value: `${this.date(group.checkInDate)} to ${this.date(group.checkOutDate)} (${group.nights} nights)`,
                status: this.datesAreFuture(group.checkInDate) ? 'ok' : 'attention',
                note: this.datesAreFuture(group.checkInDate)
                    ? undefined
                    : 'Check-in is in the past.',
            },
            this.ratesCheck(group),
            this.marginCheck(group),
            {
                key: 'cancellation',
                label: 'Cancellation terms',
                value: this.cancellationSummary(group),
                // Whether the terms are acceptable for this customer is the
                // handler's call.
                status: 'manual',
            },
            {
                key: 'payment',
                label: 'Payment terms',
                value: group.proposal?.paymentDeadline
                    ? `Payment due by ${this.date(group.proposal.paymentDeadline)}`
                    : null,
                status: group.proposal?.paymentDeadline ? 'manual' : 'attention',
                note: group.proposal?.paymentDeadline ? undefined : 'No payment deadline set.',
            },
            {
                key: 'supplier_references',
                label: 'Supplier reservation references',
                value: confirmed.map((b) => b.bookingReference).filter(Boolean).join(', ') || null,
                status: confirmed.length > 0 ? 'ok' : 'attention',
                note:
                    confirmed.length === 0
                        ? 'No confirmed reservation exists for this group.'
                        : undefined,
            },
            await this.odooOrderCheck(group.id),
        ];

        return {
            groupId: group.id,
            groupReference: group.groupReference,
            status: group.status,
            reviewedAt: group.reviewedAt,
            reviewedBy: group.reviewedBy?.email ?? null,
            reviewNotes: group.reviewNotes,
            rejectedAt: group.reviewRejectedAt,
            rejectionReason: group.reviewRejectionReason,
            checks,
            noIssuesFound: checks.every((c) => c.status !== 'attention'),
        };
    }

    /**
     * Record the handler's approval.
     *
     * Deliberately permitted even when a check is flagged: a group short two
     * rooms may still be the right thing to offer, and refusing to let a person
     * approve what they can see would push the decision outside the system. The
     * flags are recorded either way.
     */
    async approve(
        groupId: string,
        reviewerId: string,
        notes?: string,
    ): Promise<ReviewSheet> {
        const group = await prisma.bookingGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new GroupReviewError('Booking group not found', 'GROUP_NOT_FOUND');

        // Reviewing a group with nothing held would approve an offer that
        // cannot be honoured.
        if (group.roomsConfirmed === 0) {
            throw new GroupReviewError(
                'This group holds no rooms, so there is nothing to approve',
                'NOT_BOOKED',
            );
        }
        if (group.reviewedAt) {
            throw new GroupReviewError(
                `This booking was already reviewed on ${this.date(group.reviewedAt)}`,
                'ALREADY_REVIEWED',
            );
        }

        await prisma.bookingGroup.update({
            where: { id: groupId },
            data: {
                reviewedAt: new Date(),
                reviewedById: reviewerId,
                reviewNotes: notes,
                // Clear an earlier rejection: the handler has now approved, and
                // leaving both stamped would make the record contradict itself.
                reviewRejectedAt: null,
                reviewRejectionReason: null,
            },
        });

        logger.info({
            msg: 'Group booking reviewed and approved',
            groupId,
            groupReference: group.groupReference,
            reviewerId,
            roomsConfirmed: `${group.roomsConfirmed}/${group.roomsRequested}`,
        });

        return this.buildReviewSheet(groupId);
    }

    /**
     * Record the handler refusing the booking.
     *
     * A reason is required. "Rejected" with no explanation leaves whoever picks
     * the group up next with nothing to act on.
     */
    async reject(groupId: string, reviewerId: string, reason: string): Promise<ReviewSheet> {
        const group = await prisma.bookingGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new GroupReviewError('Booking group not found', 'GROUP_NOT_FOUND');

        await prisma.bookingGroup.update({
            where: { id: groupId },
            data: {
                reviewRejectedAt: new Date(),
                reviewRejectionReason: reason,
                reviewedById: reviewerId,
                // Not approved: the offer gate stays closed.
                reviewedAt: null,
            },
        });

        logger.warn({
            msg: 'Group booking rejected at review',
            groupId,
            groupReference: group.groupReference,
            reviewerId,
            reason,
        });

        return this.buildReviewSheet(groupId);
    }

    /**
     * The gate itself.
     *
     * Called before an offer is sent. Throws rather than returning false so a
     * caller cannot send by forgetting to check the result.
     */
    async assertReviewed(groupId: string): Promise<void> {
        const group = await prisma.bookingGroup.findUnique({
            where: { id: groupId },
            select: { reviewedAt: true, reviewRejectedAt: true, reviewRejectionReason: true },
        });

        if (!group) throw new GroupReviewError('Booking group not found', 'GROUP_NOT_FOUND');

        if (group.reviewRejectedAt) {
            throw new GroupReviewError(
                `This booking was rejected at review: ${group.reviewRejectionReason ?? 'no reason recorded'}`,
                'REVIEW_REJECTED',
            );
        }
        if (!group.reviewedAt) {
            throw new GroupReviewError(
                'This booking has not been reviewed by a group handler. The offer cannot be sent yet.',
                'NOT_REVIEWED',
            );
        }
    }

    /**
     * The same gate, applied to every booking made against a proposal.
     *
     * Called from the send-offer flow. Scoped to groups actually holding rooms:
     * an offer sent before anything is booked is the ordinary flow and not what
     * the review is for, so a proposal with no bookings passes.
     */
    async assertProposalReviewed(proposalId: string): Promise<void> {
        const groups = await prisma.bookingGroup.findMany({
            where: { proposalId, roomsConfirmed: { gt: 0 } },
            select: { id: true },
        });

        for (const group of groups) {
            await this.assertReviewed(group.id);
        }
    }

    /** Groups that are booked and waiting for a handler to look at them. */
    async findAwaitingReview(limit = 50) {
        return prisma.bookingGroup.findMany({
            where: {
                reviewedAt: null,
                reviewRejectedAt: null,
                // Only groups holding rooms: an unbooked group has nothing to
                // review, and a cancelled one is finished with.
                roomsConfirmed: { gt: 0 },
                status: { in: [BookingGroupStatus.confirmed, BookingGroupStatus.partial] },
            },
            include: { bookings: true },
            orderBy: { createdAt: 'asc' },
            take: limit,
        });
    }

    // ── Individual checks ────────────────────────────────────────────────────

    private ratesCheck(group: {
        quotedTotal: unknown;
        totalBooked: unknown;
        currency: string | null;
    }): ReviewCheck {
        const quoted = group.quotedTotal ? Number(group.quotedTotal) : null;
        const booked = group.totalBooked ? Number(group.totalBooked) : null;
        const cur = group.currency ?? '';

        if (quoted === null || booked === null) {
            return {
                key: 'rates',
                label: 'Buying and selling rates',
                value: [
                    quoted !== null ? `Sold at ${quoted} ${cur}` : null,
                    booked !== null ? `Bought at ${booked} ${cur}` : null,
                ]
                    .filter(Boolean)
                    .join(' · ') || null,
                status: 'attention',
                note: 'One side of the rate is missing, so the margin cannot be checked.',
            };
        }

        return {
            key: 'rates',
            label: 'Buying and selling rates',
            value: `Sold at ${quoted} ${cur} · Bought at ${booked} ${cur}`,
            status: 'ok',
        };
    }

    private marginCheck(group: { quotedTotal: unknown; totalBooked: unknown; currency: string | null }): ReviewCheck {
        const quoted = group.quotedTotal ? Number(group.quotedTotal) : null;
        const booked = group.totalBooked ? Number(group.totalBooked) : null;

        if (quoted === null || booked === null) {
            return {
                key: 'margin',
                label: 'Margin',
                value: null,
                status: 'attention',
                note: 'Cannot be calculated without both rates.',
            };
        }

        const margin = quoted - booked;
        const percent = quoted > 0 ? (margin / quoted) * 100 : 0;

        return {
            key: 'margin',
            label: 'Margin',
            value: `${margin.toFixed(2)} ${group.currency ?? ''} (${percent.toFixed(1)}%)`,
            // A negative margin is selling at a loss, which is worth stopping
            // for whatever the reason behind it.
            status: margin < 0 ? 'attention' : 'ok',
            note: margin < 0 ? 'This booking is being sold below cost.' : undefined,
        };
    }

    private async odooOrderCheck(groupId: string): Promise<ReviewCheck> {
        // The order is linked through the request rather than the group, so the
        // absence of one here is a gap the handler has to close by hand.
        const group = await prisma.bookingGroup.findUnique({
            where: { id: groupId },
            select: { requestId: true },
        });

        const order = group
            ? await prisma.bookingRequest.findUnique({
                  where: { id: group.requestId },
                  select: { odooContactId: true },
              })
            : null;

        return {
            key: 'odoo_order',
            label: 'Completeness of the Odoo sales order',
            value: order?.odooContactId ? `Customer linked (Odoo id ${order.odooContactId})` : null,
            // Whether the order itself is complete is checked in Odoo, not here.
            status: order?.odooContactId ? 'manual' : 'attention',
            note: order?.odooContactId
                ? 'Open the order in Odoo and confirm every field is populated.'
                : 'This request is not linked to an Odoo customer.',
        };
    }

    private cancellationSummary(group: {
        bookings: Array<{ nonRefundable: boolean | null; cancellationDeadline: Date | null }>;
    }): string | null {
        const nonRefundable = group.bookings.filter((b) => b.nonRefundable === true);
        if (nonRefundable.length > 0) {
            return `${nonRefundable.length} of ${group.bookings.length} reservation(s) are non-refundable`;
        }

        const deadlines = group.bookings
            .map((b) => b.cancellationDeadline)
            .filter((d): d is Date => Boolean(d))
            .sort((a, b) => a.getTime() - b.getTime());

        // The earliest deadline governs the whole group: past it, part of the
        // booking can no longer be cancelled free.
        return deadlines[0] ? `Free cancellation until ${this.date(deadlines[0])}` : null;
    }

    private datesAreFuture(checkIn: Date): boolean {
        return checkIn.getTime() > Date.now();
    }

    private date(d: Date): string {
        return d.toISOString().slice(0, 10);
    }
}

export default new GroupReviewService();
