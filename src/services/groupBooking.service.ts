import { BookingFlowStatus } from '@prisma/client';

import certificationSearchService from './certificationSearch.service';
import wbeBookingService, { BookingFlowError } from './wbeBooking.service';
import bookingGroupRepository, {
    generateGroupReference,
    type BookingGroupWithBookings,
} from '../repositories/bookingGroup.repository';
import bookingRepository, { type CreateBookingRoomData } from '../repositories/booking.repository';
import { buildSupplierSplit } from '../queue/hotelProbe.worker';
import * as cfg from '../config/groupBooking';
import logger from '../utils/logger';

/**
 * Turns an accepted proposal into real reservations.
 *
 * The problem this solves is that one customer-facing booking is rarely one
 * supplier booking. WBE caps how many rooms a single supplier will sell at
 * once, so fifteen rooms becomes several BookV2 calls — and those calls can
 * disagree with each other, leaving the group part-filled.
 *
 * Flow:
 *   read proposal → re-search for fresh TIDs → compare price against the quote
 *                 → split across suppliers → book each slice → recompute status
 *
 * Two things are deliberate:
 *
 * The search is re-run rather than reusing the TIDs from the proposal. WBE
 * sessions expire within hours and a proposal may be accepted days later, so
 * the stored TID is usually dead. Re-searching also surfaces the current price,
 * which is the only way to notice that the quote has gone stale before money
 * is committed rather than after.
 *
 * Successful slices are kept when a later one fails. Cancelling them would
 * release rooms that may not be available again and leave the customer with
 * nothing instead of most of what they asked for; the shortfall is flagged for
 * a staff member instead. See KEEP_PARTIAL_BOOKINGS.
 */

export class GroupBookingError extends Error {
    constructor(
        message: string,
        readonly code:
            | 'PROPOSAL_NOT_BOOKABLE'
            | 'NO_AVAILABILITY'
            | 'PRICE_DRIFT_EXCEEDED'
            | 'TOO_MANY_SLICES'
            | 'ALREADY_BOOKED',
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'GroupBookingError';
    }
}

export interface BookGroupParams {
    requestId: string;
    proposalId?: string;
    hotelCode: string;
    hotelName?: string;
    checkInDate: Date;
    nights: number;
    /** Total rooms the customer is owed. */
    roomsRequested: number;
    /** Price the customer accepted, used to detect drift at booking time. */
    quotedTotal?: number;
    currency?: string;
    /** Passenger manifest per room, in the order rooms should be filled. */
    rooms: CreateBookingRoomData[];
    createdById?: string;
    carbonCopyMail?: string;
    /** Book despite drift beyond tolerance — an explicit operator override. */
    acceptPriceDrift?: boolean;
}

export interface PriceDrift {
    quoted: number;
    current: number;
    /** Positive means the supplier now wants more than the customer accepted. */
    differencePercent: number;
    withinTolerance: boolean;
}

export class GroupBookingService {
    /**
     * Book a proposal as a group.
     *
     * Returns the group whatever the outcome — a caller cannot tell success
     * from partial failure by whether this throws, only by the group's status.
     * That is intentional: a part-booked group is a real result that has to be
     * persisted and shown, not an exception to unwind.
     */
    async bookGroup(params: BookGroupParams): Promise<BookingGroupWithBookings> {
        const checkIn = params.checkInDate.toISOString().slice(0, 10);

        // ── 1. Fresh availability ────────────────────────────────────────────
        const search = await certificationSearchService.search({
            hotelCodes: [params.hotelCode],
            checkInDate: checkIn,
            nights: params.nights,
            rooms: params.rooms.map((r, i) => ({
                roomId: i + 1,
                adults: r.adultsNo,
                childrenAges: r.passengers.filter((p) => p.isChild).map((p) => p.age ?? 0),
            })),
            currencyCode: params.currency,
        });

        const hotel = search.hotels.find((h) => h.hotelCode === params.hotelCode);
        const options = hotel?.options ?? [];
        if (options.length === 0) {
            throw new GroupBookingError(
                `No availability at ${params.hotelName ?? params.hotelCode} for these dates`,
                'NO_AVAILABILITY',
            );
        }

        // ── 2. Split across suppliers ────────────────────────────────────────
        // Same allocator the probe used when the price was quoted, so the
        // customer is booked against the allocation they were priced on.
        const split = buildSupplierSplit(options, params.roomsRequested, params.roomsRequested);

        if (split.length === 0) {
            throw new GroupBookingError(
                'No supplier can take these rooms within their group limits',
                'NO_AVAILABILITY',
            );
        }
        if (split.length > cfg.MAX_SLICES_PER_GROUP) {
            throw new GroupBookingError(
                `This group would split across ${split.length} suppliers, beyond the limit of ` +
                    `${cfg.MAX_SLICES_PER_GROUP}. Choose a hotel with deeper availability.`,
                'TOO_MANY_SLICES',
                { slices: split.length },
            );
        }

        // ── 3. Price check against the quote ─────────────────────────────────
        const drift = this.assessDrift(split, params.nights, params.quotedTotal);
        if (drift && !drift.withinTolerance && !params.acceptPriceDrift) {
            throw new GroupBookingError(
                `Supplier price is ${drift.differencePercent.toFixed(1)}% above the quoted total ` +
                    `(${drift.quoted} → ${drift.current} ${params.currency ?? ''}). ` +
                    `Tolerance is ${cfg.PRICE_DRIFT_TOLERANCE_PERCENT}%.`,
                'PRICE_DRIFT_EXCEEDED',
                drift,
            );
        }

        // ── 4. Persist the group before contacting WBE ───────────────────────
        // Written first so that a crash mid-booking still leaves a row naming
        // what was attempted; a reservation with nothing recorded against it is
        // the one outcome we cannot recover from.
        const group = await bookingGroupRepository.create({
            groupReference: generateGroupReference(),
            requestId: params.requestId,
            proposalId: params.proposalId,
            hotelCode: params.hotelCode,
            hotelName: params.hotelName,
            checkInDate: params.checkInDate,
            checkOutDate: new Date(search.checkOutDate),
            nights: params.nights,
            roomsRequested: params.roomsRequested,
            quotedTotal: params.quotedTotal,
            currency: params.currency,
            createdById: params.createdById,
        });

        logger.info({
            msg: 'Group booking started',
            groupId: group.id,
            groupReference: group.groupReference,
            hotelCode: params.hotelCode,
            roomsRequested: params.roomsRequested,
            slices: split.length,
            driftPercent: drift?.differencePercent,
        });

        // ── 5. Book each slice ───────────────────────────────────────────────
        let roomCursor = 0;
        for (const slice of split) {
            const sliceRooms = params.rooms.slice(roomCursor, roomCursor + slice.rooms);
            roomCursor += slice.rooms;

            await this.bookSlice(group.id, slice, sliceRooms, search.sessionId, params);
        }

        const settled = await bookingGroupRepository.recomputeStatus(group.id);

        logger.info({
            msg: 'Group booking finished',
            groupId: settled.id,
            status: settled.status,
            roomsConfirmed: `${settled.roomsConfirmed}/${settled.roomsRequested}`,
            shortfall: settled.shortfallNote ?? undefined,
        });

        return settled;
    }

    /**
     * Book one supplier's share of the group.
     *
     * Failures are swallowed on purpose. A slice that WBE refuses is recorded
     * against the booking row and the loop continues, because the alternative —
     * aborting on the first refusal — throws away rooms that were successfully
     * held by earlier slices.
     */
    private async bookSlice(
        groupId: string,
        slice: { supplierCode: string; tid: string; rooms: number; currency?: string },
        rooms: CreateBookingRoomData[],
        sessionId: string,
        params: BookGroupParams,
    ): Promise<void> {
        let bookingId: string | undefined;

        try {
            const booking = await wbeBookingService.selectOption({
                sessionId,
                tid: slice.tid,
                hotelCode: params.hotelCode,
                hotelName: params.hotelName,
                checkInDate: params.checkInDate,
                checkOutDate: new Date(
                    params.checkInDate.getTime() + params.nights * 86_400_000,
                ),
                nights: params.nights,
                currency: slice.currency ?? params.currency,
                rooms,
                requestId: params.requestId,
                createdById: params.createdById,
                carbonCopyMail: params.carbonCopyMail,
                issueVoucherOnBook: false,
            });

            bookingId = booking.id;
            await bookingGroupRepository.attachBooking(groupId, booking.id, slice.rooms);

            const prebooked = await wbeBookingService.prebook(booking.id);

            // WBE can move the price again between search and prebook, and
            // refuses BookV2 until that move is acknowledged. The drift check
            // above already cleared this group against the customer's quote, so
            // accepting here completes a decision that was made, rather than
            // making a new one. Without it the slice dies at BookV2 and the
            // group goes short for a few euros.
            if (prebooked.status === BookingFlowStatus.price_changed) {
                logger.info({
                    msg: 'Prebook price moved; accepting within the group tolerance',
                    groupId,
                    bookingId: booking.id,
                    quoted: Number(prebooked.quotedPrice ?? 0),
                    prebook: Number(prebooked.prebookPrice ?? 0),
                });
                await wbeBookingService.acceptPriceChange(booking.id);
            }

            await wbeBookingService.book(booking.id);

            logger.info({
                msg: 'Group slice booked',
                groupId,
                bookingId: booking.id,
                supplier: slice.supplierCode,
                rooms: slice.rooms,
            });
        } catch (err: any) {
            const code = err instanceof BookingFlowError ? err.code : undefined;

            logger.warn({
                msg: 'Group slice failed',
                groupId,
                bookingId,
                supplier: slice.supplierCode,
                rooms: slice.rooms,
                code,
                error: err.message,
            });

            // Record why on the row itself: the shortfall note is built from
            // these, and an operator sourcing the missing rooms needs to know
            // which supplier refused rather than that "a slice failed".
            if (bookingId) {
                await bookingRepository
                    .markFailed(bookingId, `${slice.supplierCode}: ${err.message}`)
                    .catch(() => undefined);
            }
        }
    }

    /**
     * Compare what the suppliers now want against what the customer accepted.
     *
     * Returns null when there is nothing to compare — a booking made without a
     * quote has no drift, and treating an absent quote as zero would make every
     * such booking look like a 100% increase.
     */
    private assessDrift(
        split: Array<{ rooms: number; pricePerRoomPerNight: number }>,
        nights: number,
        quotedTotal?: number,
    ): PriceDrift | null {
        if (!quotedTotal || quotedTotal <= 0) return null;

        const current = split.reduce(
            (sum, s) => sum + s.pricePerRoomPerNight * s.rooms * nights,
            0,
        );
        const differencePercent = ((current - quotedTotal) / quotedTotal) * 100;

        const withinTolerance =
            differencePercent <= cfg.PRICE_DRIFT_TOLERANCE_PERCENT &&
            (cfg.ALLOW_PRICE_DECREASE || differencePercent >= -cfg.PRICE_DRIFT_TOLERANCE_PERCENT);

        return { quoted: quotedTotal, current, differencePercent, withinTolerance };
    }

    /**
     * Cancel every confirmed slice of a group.
     *
     * Each cancellation is attempted independently so one refusal does not
     * strand the rest: a group half-cancelled is worse than one where every
     * possible cancellation was tried and the failures are recorded.
     */
    async cancelGroup(groupId: string): Promise<BookingGroupWithBookings> {
        const group = await bookingGroupRepository.findById(groupId);
        if (!group) throw new GroupBookingError('Group not found', 'PROPOSAL_NOT_BOOKABLE');

        const cancellable = group.bookings.filter(
            (b) =>
                b.status === BookingFlowStatus.booked ||
                b.status === BookingFlowStatus.vouchered,
        );

        for (const booking of cancellable) {
            try {
                await wbeBookingService.cancel(booking.id);
            } catch (err: any) {
                logger.warn({
                    msg: 'Group slice cancellation failed',
                    groupId,
                    bookingId: booking.id,
                    bookingReference: booking.bookingReference,
                    error: err.message,
                });
            }
        }

        return bookingGroupRepository.recomputeStatus(groupId);
    }
}

export default new GroupBookingService();
