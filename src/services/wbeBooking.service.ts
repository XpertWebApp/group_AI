import { BookingFlowStatus, Prisma } from '@prisma/client';
import wbeClientService from './wbe.client.service';
import bookingRepository, {
    BookingWithRooms,
    CreateBookingRoomData,
    WbeBookingSnapshot,
} from '../repositories/booking.repository';
import logger from '../utils/logger';

/**
 * Orchestrates the WBE booking lifecycle:
 *
 *   selectOption → prebook → (acceptPriceChange) → book → issueVoucher
 *                                                      ↘ syncStatus / cancel
 *
 * The rules enforced here come straight from WBE's XMLOUT documentation and
 * exist because breaking them costs money rather than throwing an error:
 *
 *  1. OptionDetailsV2 with Prebook=true may run exactly once per flow. The
 *     claim is taken atomically in the repository, not checked in memory.
 *  2. If the prebook price differs from the quoted price, the user must
 *     explicitly accept before BookV2 is allowed.
 *  3. BookV2 is never retried automatically. An ambiguous failure is
 *     reconciled by AgencyReference instead, because a retry could double-book.
 *  4. Passenger lists must match the occupancy the option was searched with.
 */

/** Thrown for rule violations, so callers can map them to 4xx rather than 500. */
export class BookingFlowError extends Error {
    constructor(
        message: string,
        readonly code:
            | 'INVALID_STATE'
            | 'ALREADY_PREBOOKED'
            | 'PRICE_CHANGE_UNACCEPTED'
            | 'PASSENGER_MISMATCH'
            | 'NOT_FOUND'
            | 'WBE_REJECTED'
            | 'AMBIGUOUS_BOOKING',
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'BookingFlowError';
    }
}

export interface SelectOptionParams {
    sessionId: string;
    tid: string;
    hotelCode: string;
    hotelName?: string;
    destinationId?: number;
    destinationName?: string;
    checkInDate: Date;
    checkOutDate: Date;
    nights: number;
    /** Price shown to the user, from OptionDetailsV2 with Prebook=false. */
    quotedPrice?: number;
    currency?: string;
    rooms: CreateBookingRoomData[];
    hotelNotes?: string;
    carbonCopyMail?: string;
    issueVoucherOnBook?: boolean;
    requestId?: string;
    createdById?: string;
    isCertificationTest?: boolean;
    certificationScenario?: number;
    /** Supplied only to make a booking reproducible; normally auto-generated. */
    agencyReference?: string;
}

/** Read a field WBE may return in PascalCase or camelCase. */
function field<T>(obj: any, ...keys: string[]): T | undefined {
    for (const k of keys) {
        if (obj != null && obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
    }
    return undefined;
}

function toDate(value: unknown): Date | undefined {
    if (!value || typeof value !== 'string') return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

function toNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

/** True when WBE signalled failure at the envelope level. */
function isFailureEnvelope(response: any): boolean {
    const success = field<boolean>(response, 'Success', 'success');
    return success === false;
}

function messagesOf(response: any): string {
    const messages = field<any[]>(response, 'Messages', 'messages') ?? [];
    return messages.filter(Boolean).map(String).join('; ');
}

/**
 * Generate the AgencyReference sent to WBE.
 *
 * WBE requires global uniqueness per booking. Time plus randomness is enough
 * in practice, and the DB unique index on agency_reference is the real
 * guarantee — a collision surfaces as a create failure rather than silently
 * attaching to someone else's reservation.
 */
export function generateAgencyReference(prefix = 'SETT'): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `${prefix}-${stamp}-${rand}`;
}

/**
 * Check that supplied passengers match the occupancy each room was searched
 * with. WBE rejects a mismatch, but only after the prebook has been consumed —
 * so this runs before any WBE call.
 */
export function validatePassengers(rooms: CreateBookingRoomData[]): string[] {
    const errors: string[] = [];

    rooms.forEach((room) => {
        const label = `Room ${room.roomId}`;
        const adults = room.passengers.filter((p) => !p.isChild);
        const children = room.passengers.filter((p) => p.isChild);

        if (adults.length !== room.adultsNo) {
            errors.push(`${label}: expected ${room.adultsNo} adult passenger(s), got ${adults.length}`);
        }
        if (children.length !== room.childrenNo) {
            errors.push(`${label}: expected ${room.childrenNo} child passenger(s), got ${children.length}`);
        }

        children.forEach((c, i) => {
            if (c.age === undefined || c.age === null) {
                errors.push(`${label}, child ${i + 1}: age is required for child passengers`);
            }
            if (c.salutation !== 'Chd') {
                errors.push(`${label}, child ${i + 1}: salutation must be "Chd", got "${c.salutation}"`);
            }
        });

        adults.forEach((a, i) => {
            if (!['Mr', 'Ms', 'Mrs', 'Miss'].includes(a.salutation)) {
                errors.push(`${label}, adult ${i + 1}: salutation must be Mr, Ms, Mrs or Miss; got "${a.salutation}"`);
            }
        });

        room.passengers.forEach((p, i) => {
            if (!p.firstName?.trim()) errors.push(`${label}, passenger ${i + 1}: firstName is required`);
            if (!p.lastName?.trim()) errors.push(`${label}, passenger ${i + 1}: lastName is required`);
        });
    });

    const leaders = rooms.flatMap((r) => r.passengers).filter((p) => p.isLeader);
    if (leaders.length > 1) {
        errors.push(`Only one passenger may be marked as leader; got ${leaders.length}`);
    }

    return errors;
}

/** Lift the fields we persist out of an OptionDetailsV2 response. */
function parseOptionDetails(response: any): {
    totalPrice?: number;
    currency?: string;
    nonRefundable?: boolean;
    cancellationDeadline?: Date;
    cancellationConditions?: string;
    mealType?: string;
    mealName?: string;
} {
    const data = field<any>(response, 'Data', 'data') ?? {};
    const dayPrices = data.DayPrices ?? data.dayPrices ?? {};
    const cxl = data.CxlPolicy ?? data.cxlPolicy ?? {};

    const conditions = field<any[]>(cxl, 'Conditions', 'conditions') ?? [];
    const comment = field<string>(cxl, 'Comment', 'comment');
    // Conditions is always empty for a non-refundable option, so fall back to
    // the comment to keep some human-readable policy text on the booking.
    const conditionsText = conditions.length
        ? conditions
              .map((c: any) => field<string>(c, 'Text', 'text'))
              .filter(Boolean)
              .join(' | ')
        : undefined;

    return {
        totalPrice: toNumber(field(dayPrices, 'TotalPrice', 'totalPrice', 'Total', 'total')),
        currency: field<string>(dayPrices, 'Currency', 'currency'),
        nonRefundable: field<boolean>(cxl, 'NonRefundable', 'nonRefundable'),
        cancellationDeadline: toDate(field(cxl, 'OptionDate', 'optionDate')),
        cancellationConditions: conditionsText ?? comment,
        mealType: field<string>(dayPrices, 'MealType', 'mealType'),
        mealName: field<string>(dayPrices, 'MealName', 'mealName'),
    };
}

/** Lift the fields we persist out of a Book/BookingDetails/Voucher response. */
function parseBookingSnapshot(response: any): WbeBookingSnapshot {
    const data = field<any>(response, 'Data', 'data') ?? {};

    // VoucherData is documented as an object but observed as an array; keep
    // only populated values so an empty array does not overwrite a real voucher.
    const rawVoucher = field<any>(data, 'VoucherData', 'voucherData');
    const voucherData =
        rawVoucher && (!Array.isArray(rawVoucher) || rawVoucher.length > 0)
            ? (rawVoucher as Prisma.InputJsonValue)
            : undefined;

    return {
        bookingReference: field<string>(data, 'BookingReference', 'bookingReference'),
        providerReference: field<string>(data, 'ProviderReference', 'providerReference'),
        wbeStatus: field<string>(data, 'BookingStatus', 'bookingStatus'),
        totalPrice: toNumber(field(data, 'Price', 'price')),
        currency: field<string>(data, 'Currency', 'currency'),
        nonRefundable: field<boolean>(data, 'NonRefundable', 'nonRefundable'),
        cancellationDeadline: toDate(field(data, 'CancellationDeadline', 'cancellationDeadline')),
        cancellationConditions: field<string>(data, 'CancellationConditions', 'cancellationConditions'),
        isPaid: field<boolean>(data, 'IsPaid', 'isPaid'),
        supplierCode: field<string>(data, 'SupplierCode', 'supplierCode'),
        essentialInfo: field<string>(data, 'EssentialInfo', 'essentialInfo'),
        hotelConfirmationNumber: field<string>(data, 'HotelConfirmationNumber', 'hotelConfirmationNumber'),
        originalProviderResponse: field<string>(data, 'OriginalProviderResponse', 'originalProviderResponse'),
        hotelName: field<string>(data, 'HotelName', 'hotelName'),
        destinationId: toNumber(field(data, 'DestinationId', 'destinationId')),
        destinationName: field<string>(data, 'DestinationName', 'destinationName'),
        voucherData,
    };
}

export class WbeBookingService {
    /**
     * Persist a chosen option as a draft booking.
     *
     * Written before WBE is contacted so the AgencyReference exists locally
     * first — it is the only handle for reconciling a booking whose BookV2
     * response is lost.
     */
    async selectOption(params: SelectOptionParams): Promise<BookingWithRooms> {
        const errors = validatePassengers(params.rooms);
        if (errors.length > 0) {
            throw new BookingFlowError(
                `Passenger details do not match room occupancy: ${errors.join('; ')}`,
                'PASSENGER_MISMATCH',
                errors,
            );
        }

        const booking = await bookingRepository.create({
            ...params,
            agencyReference: params.agencyReference ?? generateAgencyReference(),
        });

        logger.info({
            msg: 'Booking option selected',
            bookingId: booking.id,
            agencyReference: booking.agencyReference,
            hotelCode: booking.hotelCode,
            isCertificationTest: booking.isCertificationTest,
        });

        return booking;
    }

    /**
     * Run the mandatory OptionDetailsV2 call with Prebook=true.
     *
     * The claim is taken before the WBE call, so a crash mid-call leaves the
     * booking blocked rather than able to prebook twice. The claim is released
     * only when the request provably never reached WBE.
     */
    async prebook(bookingId: string): Promise<BookingWithRooms> {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw new BookingFlowError('Booking not found', 'NOT_FOUND');

        // Check the prebook marker before the status, so a booking that has
        // already consumed its single prebook reports ALREADY_PREBOOKED rather
        // than a generic INVALID_STATE. The distinction matters to the caller:
        // one means "not yet, do something else first", the other means "this
        // flow is spent — WBE will not allow another Prebook=true".
        if (booking.prebookedAt) {
            throw new BookingFlowError(
                'This booking has already been prebooked; WBE permits Prebook=true only once per flow',
                'ALREADY_PREBOOKED',
            );
        }
        if (booking.status !== BookingFlowStatus.draft) {
            throw new BookingFlowError(
                `Cannot prebook a booking in status "${booking.status}"`,
                'INVALID_STATE',
            );
        }

        const claimed = await bookingRepository.claimPrebook(bookingId);
        if (!claimed) {
            throw new BookingFlowError(
                'This booking has already been prebooked; WBE permits Prebook=true only once per flow',
                'ALREADY_PREBOOKED',
            );
        }

        let response: any;
        try {
            response = await wbeClientService.optionDetailsV2({
                SessionID: booking.sessionId,
                TID: booking.tid,
                HotelCode: booking.hotelCode,
                Prebook: true,
                ...this.buildOptionalExtras(booking),
            });
        } catch (err: any) {
            // No response at all means WBE never reserved anything, so the
            // claim can be safely reopened. Any response — including an error
            // one — may have consumed the prebook, so the claim must stand.
            const reachedWbe = Boolean(err.response);
            if (!reachedWbe) {
                await bookingRepository.releasePrebookClaim(bookingId);
            } else {
                await bookingRepository.markFailed(bookingId, `Prebook rejected by WBE: ${err.message}`);
            }
            throw new BookingFlowError(
                `Prebook failed: ${err.message}`,
                'WBE_REJECTED',
                { reachedWbe },
            );
        }

        if (isFailureEnvelope(response)) {
            const reason = messagesOf(response) || 'unknown reason';
            await bookingRepository.markFailed(bookingId, `Prebook rejected by WBE: ${reason}`);
            throw new BookingFlowError(`Prebook rejected by WBE: ${reason}`, 'WBE_REJECTED');
        }

        const details = parseOptionDetails(response);
        const quoted = booking.quotedPrice ? Number(booking.quotedPrice) : undefined;
        const prebookPrice = details.totalPrice;

        // WBE requires the user to accept a price move before booking. Compare
        // in minor units to avoid float noise being read as a real change.
        const priceChanged =
            quoted !== undefined &&
            prebookPrice !== undefined &&
            Math.round(quoted * 100) !== Math.round(prebookPrice * 100);

        const updated = await bookingRepository.recordPrebookResult(bookingId, {
            prebookPrice,
            currency: details.currency ?? booking.currency ?? undefined,
            nonRefundable: details.nonRefundable,
            cancellationDeadline: details.cancellationDeadline,
            cancellationConditions: details.cancellationConditions,
            status: priceChanged ? BookingFlowStatus.price_changed : BookingFlowStatus.prebooked,
        });

        logger.info({
            msg: 'Booking prebooked',
            bookingId,
            quotedPrice: quoted,
            prebookPrice,
            priceChanged,
            nonRefundable: details.nonRefundable,
        });

        return updated;
    }

    /** Record the user's acceptance of a quoted → prebook price change. */
    async acceptPriceChange(bookingId: string): Promise<BookingWithRooms> {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw new BookingFlowError('Booking not found', 'NOT_FOUND');

        if (booking.status !== BookingFlowStatus.price_changed) {
            throw new BookingFlowError(
                `No price change is pending for this booking (status "${booking.status}")`,
                'INVALID_STATE',
            );
        }

        return bookingRepository.acceptPriceChange(bookingId);
    }

    /**
     * Dispatch BookV2.
     *
     * Never retried. If the outcome is ambiguous the booking stays in
     * `booking` and reconcile() must resolve it against WBE, because a second
     * dispatch could create a duplicate reservation.
     */
    async book(bookingId: string): Promise<BookingWithRooms> {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw new BookingFlowError('Booking not found', 'NOT_FOUND');

        if (booking.status === BookingFlowStatus.price_changed) {
            throw new BookingFlowError(
                'The price changed at prebook and has not been accepted; acceptance is required before booking',
                'PRICE_CHANGE_UNACCEPTED',
            );
        }
        if (booking.status !== BookingFlowStatus.prebooked) {
            throw new BookingFlowError(
                `Cannot book from status "${booking.status}"; the booking must be prebooked first`,
                'INVALID_STATE',
            );
        }
        if (!booking.prebookedAt) {
            throw new BookingFlowError(
                'BookV2 requires a completed OptionDetailsV2 call with Prebook=true',
                'INVALID_STATE',
            );
        }

        const payload = this.buildBookPayload(booking);

        // Guarded transition: refuses if another request already dispatched.
        const dispatching = await bookingRepository.markDispatching(
            bookingId,
            payload as unknown as Prisma.InputJsonValue,
        );
        if (!dispatching) {
            throw new BookingFlowError(
                'This booking is already being dispatched or has been booked',
                'INVALID_STATE',
            );
        }

        let response: any;
        try {
            response = await wbeClientService.bookV2(payload);
        } catch (err: any) {
            const reachedWbe = Boolean(err.response);
            if (!reachedWbe) {
                // Request never left; no reservation can exist upstream.
                await bookingRepository.markFailed(
                    bookingId,
                    `BookV2 failed before reaching WBE: ${err.message}`,
                );
                throw new BookingFlowError(`Booking failed: ${err.message}`, 'WBE_REJECTED');
            }

            // WBE responded with an error, but a reservation may still have
            // been created. Leave the row dispatched for reconcile() and do
            // NOT retry.
            await bookingRepository.markFailed(
                bookingId,
                `BookV2 returned an error; booking may exist upstream: ${err.message}`,
                { preserveDispatched: true },
            );
            logger.error({
                msg: 'BookV2 ambiguous failure — reconciliation required',
                bookingId,
                agencyReference: booking.agencyReference,
                error: err.message,
            });
            throw new BookingFlowError(
                'Booking could not be confirmed and may exist at WBE. Reconcile by agency reference before retrying.',
                'AMBIGUOUS_BOOKING',
                { agencyReference: booking.agencyReference },
            );
        }

        const snapshot = parseBookingSnapshot(response);

        // Per WBE: no booking reference means no booking was made.
        if (!snapshot.bookingReference) {
            const reason = messagesOf(response) || 'no booking reference returned';
            await bookingRepository.markFailed(bookingId, `BookV2 did not create a booking: ${reason}`);
            throw new BookingFlowError(`Booking was not created by WBE: ${reason}`, 'WBE_REJECTED');
        }

        const booked = await bookingRepository.markBooked(
            bookingId,
            snapshot,
            response as Prisma.InputJsonValue,
        );

        logger.info({
            msg: 'Booking confirmed by WBE',
            bookingId,
            bookingReference: snapshot.bookingReference,
            wbeStatus: snapshot.wbeStatus,
            totalPrice: snapshot.totalPrice,
        });

        return booked;
    }

    /**
     * Resolve a booking left in `booking` after an ambiguous dispatch, by
     * asking WBE what exists under our AgencyReference. This is the only safe
     * alternative to retrying BookV2.
     */
    async reconcile(bookingId: string): Promise<BookingWithRooms> {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw new BookingFlowError('Booking not found', 'NOT_FOUND');

        let response: any;
        try {
            response = await wbeClientService.bookingDetailsByAgencyReference(booking.agencyReference);
        } catch (err: any) {
            throw new BookingFlowError(
                `Reconciliation lookup failed: ${err.message}`,
                'WBE_REJECTED',
            );
        }

        const snapshot = parseBookingSnapshot(response);

        if (!snapshot.bookingReference) {
            // Nothing exists upstream, so the dispatch genuinely failed and
            // the flow can be marked failed rather than left ambiguous.
            await bookingRepository.markFailed(
                bookingId,
                'Reconciliation found no booking at WBE for this agency reference',
            );
            logger.info({ msg: 'Reconciliation: no upstream booking', bookingId });
            const refreshed = await bookingRepository.findById(bookingId);
            return refreshed!;
        }

        const synced = await bookingRepository.syncFromWbe(bookingId, snapshot);
        logger.info({
            msg: 'Reconciliation recovered a booking',
            bookingId,
            bookingReference: snapshot.bookingReference,
            wbeStatus: snapshot.wbeStatus,
        });
        return synced;
    }

    /** Refresh a booking from WBE. Read-only and safe to call repeatedly. */
    async syncStatus(bookingId: string): Promise<BookingWithRooms> {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw new BookingFlowError('Booking not found', 'NOT_FOUND');
        if (!booking.bookingReference) {
            throw new BookingFlowError('Booking has no WBE reference to sync', 'INVALID_STATE');
        }

        const response = await wbeClientService.bookingDetails(booking.bookingReference);
        return bookingRepository.syncFromWbe(bookingId, parseBookingSnapshot(response));
    }

    /**
     * Issue the voucher for a confirmed booking.
     *
     * Kept separate from BookV2 (IssueVoucher=false at book time) so booking
     * and voucher stay independently controllable — the answer given to WBE's
     * certification questionnaire.
     */
    async issueVoucher(bookingId: string): Promise<BookingWithRooms> {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw new BookingFlowError('Booking not found', 'NOT_FOUND');
        if (!booking.bookingReference) {
            throw new BookingFlowError('Booking has no WBE reference', 'INVALID_STATE');
        }
        if (booking.status === BookingFlowStatus.vouchered) {
            return booking;
        }
        if (booking.status !== BookingFlowStatus.booked) {
            throw new BookingFlowError(
                `Cannot issue a voucher from status "${booking.status}"`,
                'INVALID_STATE',
            );
        }

        const response = await wbeClientService.issueVoucher(booking.bookingReference);
        if (isFailureEnvelope(response)) {
            const reason = messagesOf(response) || 'unknown reason';
            throw new BookingFlowError(`Voucher issuance rejected by WBE: ${reason}`, 'WBE_REJECTED');
        }

        const updated = await bookingRepository.markVouchered(bookingId, parseBookingSnapshot(response));
        logger.info({ msg: 'Voucher issued', bookingId, bookingReference: booking.bookingReference });
        return updated;
    }

    /**
     * Cancel a booking.
     *
     * A PNDC outcome is not a completed cancellation: WBE could not settle it
     * automatically and a human must confirm on their side, so the booking is
     * left in pending_cancellation rather than reported as cancelled.
     */
    async cancel(bookingId: string): Promise<BookingWithRooms> {
        const booking = await bookingRepository.findById(bookingId);
        if (!booking) throw new BookingFlowError('Booking not found', 'NOT_FOUND');
        if (!booking.bookingReference) {
            throw new BookingFlowError('Booking has no WBE reference to cancel', 'INVALID_STATE');
        }
        if (
            booking.status === BookingFlowStatus.cancelled ||
            booking.status === BookingFlowStatus.pending_cancellation
        ) {
            return booking;
        }

        const response = await wbeClientService.cancelBookingV2(booking.bookingReference);
        const data = field<any>(response, 'Data', 'data') ?? {};
        const wbeStatus = field<string>(data, 'BookingStatus', 'bookingStatus');

        // A failed cancellation still moves the booking to PNDC at WBE, so the
        // envelope being unsuccessful is recorded rather than thrown away.
        if (isFailureEnvelope(response) && !wbeStatus) {
            const reason = messagesOf(response) || 'unknown reason';
            await bookingRepository.markCancelled(bookingId, { wbeStatus: 'PNDC' });
            throw new BookingFlowError(
                `Cancellation did not complete and is pending manual confirmation at WBE: ${reason}`,
                'WBE_REJECTED',
            );
        }

        const updated = await bookingRepository.markCancelled(bookingId, {
            wbeStatus,
            cancellationCharge: toNumber(field(data, 'Price', 'price')),
        });

        logger.info({
            msg: 'Booking cancellation processed',
            bookingId,
            bookingReference: booking.bookingReference,
            wbeStatus,
            charge: updated.cancellationCharge,
        });

        return updated;
    }

    /** BookV2 request body, built from the persisted booking. */
    private buildBookPayload(booking: BookingWithRooms): Record<string, unknown> {
        return {
            SessionID: booking.sessionId,
            TID: booking.tid,
            HotelCode: booking.hotelCode,
            PaymentOption: booking.paymentOption,
            AgencyReference: booking.agencyReference,
            ...(booking.hotelNotes ? { HotelNotes: booking.hotelNotes } : {}),
            ...(booking.carbonCopyMail ? { CarbonCopyMail: booking.carbonCopyMail } : {}),
            IssueVoucher: booking.issueVoucherOnBook,
            Rooms: booking.rooms.map((room) => ({
                RoomId: room.roomId,
                AdultsNo: room.adultsNo,
                ChildrenNo: room.childrenNo,
                Passengers: room.passengers.map((p) => ({
                    Salutation: p.salutation,
                    FirstName: p.firstName,
                    LastName: p.lastName,
                    IsChild: p.isChild,
                    // Age is included only for children: WBE's spec requires
                    // the attribute to be absent for adults, and sending 0
                    // is a rejection rather than a no-op.
                    ...(p.isChild && p.age !== null ? { Age: p.age } : {}),
                })),
            })),
            ...this.buildOptionalExtras(booking),
        };
    }

    /** OptionalExtras block, omitted entirely when no extras were chosen. */
    private buildOptionalExtras(booking: BookingWithRooms): Record<string, unknown> {
        const extras = booking.rooms
            .filter((r) => Array.isArray(r.optionalExtras) && (r.optionalExtras as number[]).length > 0)
            .map((r) => ({ RoomId: r.roomId, Extras: r.optionalExtras as number[] }));

        return extras.length > 0 ? { OptionalExtras: extras } : {};
    }
}

export default new WbeBookingService();
