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

/**
 * Convert an option's total into the per-room-per-night figure the allocator
 * ranks on.
 *
 * WBE prices an option as a whole — every room, every night — while the split
 * has to compare suppliers room by room. Mirrors the normalisation the probe
 * worker applies when the price is first quoted, so an option is ranked the
 * same way at booking time as it was at search time.
 */
export function perRoomPerNight(totalPrice: number, rooms: number, nights: number): number {
    const divisor = Math.max(1, rooms) * Math.max(1, nights);
    return totalPrice / divisor;
}

/**
 * Most rooms WBE will accept on a single availability search.
 *
 * Measured against UAT rather than assumed: four rooms returns a SessionID,
 * five returns none at all — no error, just an empty session, which kills the
 * flow before option details or booking. The same boundary held across
 * different hotels, so it is an API limit rather than a property's inventory.
 *
 * This is why a group cannot be booked from one search. Each supplier's share
 * is searched and booked on its own session, and WBE refuses a booking whose
 * room count differs from the search behind it:
 *
 *   "The number of rooms is not the same as it was searched for"
 */
const MAX_ROOMS_PER_SEARCH = 4;

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
        // Searched with a small sample of the group, never its full size. WBE
        // stops returning a SessionID above a handful of rooms — verified
        // against UAT, where three rooms answered and seven did not — and
        // without a session nothing downstream can run. This is the same rule
        // the quote was priced under (hotelSearch.service SEARCH_ROOMS), so the
        // options here are the ones the customer was shown.
        //
        // Room counts are not lost by doing this: how many rooms each supplier
        // takes is decided by the split, and the manifest still carries every
        // guest.
        const sampleRooms = params.rooms.slice(0, MAX_ROOMS_PER_SEARCH);

        const search = await certificationSearchService.search({
            hotelCodes: [params.hotelCode],
            checkInDate: checkIn,
            nights: params.nights,
            rooms: sampleRooms.map((r, i) => ({
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
        //
        // The search returns a total for the whole option; the allocator ranks
        // on price per room per night. Converting here rather than passing the
        // raw option through is what keeps the drift check meaningful — an
        // absent field would make the comparison NaN, and NaN silently passes
        // every tolerance test.
        const priced = options.map((o) => ({
            ...o,
            pricePerRoomPerNight: perRoomPerNight(o.totalPrice, o.rooms?.length ?? 1, params.nights),
        }));

        const split = buildSupplierSplit(priced, params.roomsRequested, params.roomsRequested);

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

        // ── 5. Book each chunk on its own search ─────────────────────────────
        // WBE will not book a different number of rooms than the search behind
        // it asked for, and it caps a search at MAX_ROOMS_PER_SEARCH. So each
        // chunk gets its own search for exactly the rooms it will book, and the
        // supplier chosen for that chunk comes from that search's own options.
        //
        // The planning search above is still what decided the split and cleared
        // the price; these searches carry it out.
        let roomCursor = 0;
        for (const slice of split) {
            let remaining = slice.rooms;

            while (remaining > 0) {
                const take = Math.min(remaining, MAX_ROOMS_PER_SEARCH);
                const chunkRooms = params.rooms.slice(roomCursor, roomCursor + take);
                roomCursor += take;
                remaining -= take;

                await this.bookChunk(group.id, slice.supplierCode, chunkRooms, params);
            }
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
     * Search for one chunk of rooms and book them.
     *
     * The search is run here, for exactly the rooms this booking will carry:
     * WBE rejects a booking whose room count differs from its search, and caps
     * a search at MAX_ROOMS_PER_SEARCH. A chunk therefore owns its session and
     * its TID rather than borrowing the planning search's.
     *
     * `preferredSupplier` is what the planning split chose. It is a preference
     * and not a requirement — this search is a fresh look at availability, and
     * refusing to book because that supplier no longer appears would lose rooms
     * over a detail the customer never sees.
     *
     * Failures are swallowed on purpose. A chunk that WBE refuses is recorded
     * against its booking row and the loop continues, because aborting on the
     * first refusal throws away rooms earlier chunks already hold.
     */
    private async bookChunk(
        groupId: string,
        preferredSupplier: string,
        rooms: CreateBookingRoomData[],
        params: BookGroupParams,
    ): Promise<void> {
        let bookingId: string | undefined;

        // Renumber the chunk's rooms from 1. WBE matches passengers to the
        // rooms it was searched for by id, and rejects the booking outright
        // when they disagree:
        //
        //   "Room id must be the same for each room between search and book
        //    passengers"
        //
        // The manifest numbers rooms across the whole group, so the second
        // chunk arrives holding rooms 5–8 against a search that asked for 1–4.
        const chunkRooms = rooms.map((r, i) => ({ ...r, roomId: i + 1 }));

        try {
            const search = await certificationSearchService.search({
                hotelCodes: [params.hotelCode],
                checkInDate: params.checkInDate.toISOString().slice(0, 10),
                nights: params.nights,
                rooms: chunkRooms.map((r) => ({
                    roomId: r.roomId,
                    adults: r.adultsNo,
                    childrenAges: r.passengers.filter((p) => p.isChild).map((p) => p.age ?? 0),
                })),
                currencyCode: params.currency,
            });

            const options = search.hotels.find((h) => h.hotelCode === params.hotelCode)?.options ?? [];
            if (options.length === 0) {
                throw new Error(`No availability for ${rooms.length} room(s) at this hotel`);
            }

            // Prefer the planned supplier; fall back to whatever this search
            // offers, since holding the rooms matters more than which channel
            // they come from.
            const option =
                options.find((o) => o.supplierCode === preferredSupplier && !o.onRequest) ??
                options.find((o) => !o.onRequest) ??
                options[0]!;

            const booking = await wbeBookingService.selectOption({
                sessionId: search.sessionId,
                tid: option.tid,
                hotelCode: params.hotelCode,
                hotelName: params.hotelName,
                checkInDate: params.checkInDate,
                checkOutDate: new Date(
                    params.checkInDate.getTime() + params.nights * 86_400_000,
                ),
                nights: params.nights,
                currency: option.currency ?? params.currency,
                rooms: chunkRooms,
                requestId: params.requestId,
                createdById: params.createdById,
                carbonCopyMail: params.carbonCopyMail,
                issueVoucherOnBook: false,
            });

            bookingId = booking.id;
            await bookingGroupRepository.attachBooking(groupId, booking.id, rooms.length);

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
                msg: 'Group chunk booked',
                groupId,
                bookingId: booking.id,
                supplier: option.supplierCode,
                rooms: rooms.length,
            });
        } catch (err: any) {
            const code = err instanceof BookingFlowError ? err.code : undefined;

            logger.warn({
                msg: 'Group chunk failed',
                groupId,
                bookingId,
                supplier: preferredSupplier,
                rooms: rooms.length,
                code,
                error: err.message,
            });

            // Record why on the row itself: the shortfall note is built from
            // these, and an operator sourcing the missing rooms needs to know
            // which supplier refused rather than that "a chunk failed".
            if (bookingId) {
                await bookingRepository
                    .markFailed(bookingId, `${preferredSupplier}: ${err.message}`)
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

        // A missing or unparseable price makes `current` NaN, and every NaN
        // comparison is false — so a broken price would report itself as within
        // tolerance and book at whatever the supplier asked. Refuse instead.
        if (!Number.isFinite(current) || current <= 0) {
            throw new GroupBookingError(
                'Supplier options carry no usable price, so the quoted total cannot be checked',
                'NO_AVAILABILITY',
                { quotedTotal },
            );
        }

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
