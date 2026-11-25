import { PrismaClient, Prisma, BookingFlowStatus } from '@prisma/client';

const prisma = new PrismaClient();

/** A passenger as persisted against a room. */
export interface CreateBookingPassengerData {
    salutation: string;
    firstName: string;
    lastName: string;
    isChild: boolean;
    /** Required for children; must be undefined for adults. */
    age?: number;
    isLeader?: boolean;
}

/** A room, with its passengers, as persisted against a booking. */
export interface CreateBookingRoomData {
    /** 1-based index matching the RoomId sent to WBE. */
    roomId: number;
    adultsNo: number;
    childrenNo: number;
    roomDescription?: string;
    mealType?: string;
    mealName?: string;
    price?: number;
    /** Chosen SupplementId values for this room. */
    optionalExtras?: number[];
    passengers: CreateBookingPassengerData[];
}

export interface CreateBookingData {
    agencyReference: string;
    sessionId: string;
    tid: string;
    hotelCode: string;
    hotelName?: string;
    destinationId?: number;
    destinationName?: string;
    checkInDate: Date;
    checkOutDate: Date;
    nights: number;
    quotedPrice?: number;
    currency?: string;
    nonRefundable?: boolean;
    cancellationDeadline?: Date;
    cancellationConditions?: string;
    hotelNotes?: string;
    carbonCopyMail?: string;
    issueVoucherOnBook?: boolean;
    requestId?: string;
    createdById?: string;
    isCertificationTest?: boolean;
    certificationScenario?: number;
    rooms: CreateBookingRoomData[];
}

/** Fields lifted from a WBE booking/voucher/cancel response. */
export interface WbeBookingSnapshot {
    bookingReference?: string;
    providerReference?: string;
    wbeStatus?: string;
    totalPrice?: number;
    currency?: string;
    nonRefundable?: boolean;
    cancellationDeadline?: Date;
    cancellationConditions?: string;
    isPaid?: boolean;
    supplierCode?: string;
    essentialInfo?: string;
    hotelConfirmationNumber?: string;
    originalProviderResponse?: string;
    voucherData?: Prisma.InputJsonValue;
    hotelName?: string;
    destinationId?: number;
    destinationName?: string;
}

/** Booking with its rooms and passengers, ordered as WBE expects. */
const withRooms = {
    rooms: {
        orderBy: { roomId: 'asc' },
        include: { passengers: { orderBy: { createdAt: 'asc' } } },
    },
} satisfies Prisma.BookingInclude;

export type BookingWithRooms = Prisma.BookingGetPayload<{ include: typeof withRooms }>;

export class BookingRepository {
    /**
     * Create a booking in `draft` together with its rooms and passengers.
     *
     * The row is written before WBE is contacted so that the agencyReference
     * exists locally even if the later bookV2 call fails or times out — that
     * reference is the only handle for reconciling an ambiguous booking.
     *
     * A duplicate agencyReference raises Prisma P2002 against
     * `bookings_agency_reference_key`; callers should surface that as a
     * conflict rather than retrying with the same reference.
     */
    async create(data: CreateBookingData): Promise<BookingWithRooms> {
        const { rooms, ...booking } = data;

        return prisma.booking.create({
            data: {
                ...booking,
                status: BookingFlowStatus.draft,
                rooms: {
                    create: rooms.map((room) => ({
                        roomId: room.roomId,
                        adultsNo: room.adultsNo,
                        childrenNo: room.childrenNo,
                        roomDescription: room.roomDescription,
                        mealType: room.mealType,
                        mealName: room.mealName,
                        price: room.price,
                        optionalExtras: room.optionalExtras ?? undefined,
                        passengers: {
                            create: room.passengers.map((p) => ({
                                salutation: p.salutation,
                                firstName: p.firstName,
                                lastName: p.lastName,
                                isChild: p.isChild,
                                // Left NULL for adults on purpose: WBE requires
                                // Age to be absent, and a 0 would be sent.
                                age: p.isChild ? p.age : null,
                                isLeader: p.isLeader ?? false,
                            })),
                        },
                    })),
                },
            },
            include: withRooms,
        });
    }

    async findById(id: string): Promise<BookingWithRooms | null> {
        return prisma.booking.findUnique({ where: { id }, include: withRooms });
    }

    async findByAgencyReference(agencyReference: string): Promise<BookingWithRooms | null> {
        return prisma.booking.findUnique({ where: { agencyReference }, include: withRooms });
    }

    async findByBookingReference(bookingReference: string): Promise<BookingWithRooms | null> {
        return prisma.booking.findUnique({ where: { bookingReference }, include: withRooms });
    }

    /**
     * Claim the single permitted prebook for this booking.
     *
     * WBE allows OptionDetailsV2 with Prebook=true exactly once per booking
     * flow, so the guard cannot be a read-then-write: two concurrent requests
     * would both observe `prebookedAt: null` and both dispatch. Instead the
     * claim is a conditional updateMany on `prebookedAt: null`, which Postgres
     * settles atomically — exactly one caller sees count 1.
     *
     * Returns true if this caller won the claim and may call WBE.
     *
     * The timestamp is written *before* the WBE call, so a failed prebook
     * leaves the booking unusable rather than risking a second attempt. Use
     * releasePrebookClaim() to reopen it only when WBE is known not to have
     * reserved anything (e.g. a transport-level failure with no response).
     */
    async claimPrebook(id: string): Promise<boolean> {
        const { count } = await prisma.booking.updateMany({
            where: { id, prebookedAt: null },
            data: { prebookedAt: new Date() },
        });
        return count === 1;
    }

    /**
     * Reopen the prebook claim after a call that provably never reached WBE.
     * Only safe when no response was received at all; if WBE replied with an
     * error the option may still be reserved upstream and the claim must stand.
     */
    async releasePrebookClaim(id: string): Promise<void> {
        await prisma.booking.update({
            where: { id },
            data: { prebookedAt: null, lastError: 'Prebook released: request never reached WBE' },
        });
    }

    /** Record the price returned by the mandatory Prebook=true call. */
    async recordPrebookResult(
        id: string,
        opts: {
            prebookPrice?: number;
            currency?: string;
            nonRefundable?: boolean;
            cancellationDeadline?: Date;
            cancellationConditions?: string;
            /** price_changed when the price moved, prebooked when it held. */
            status: BookingFlowStatus;
        },
    ): Promise<BookingWithRooms> {
        return prisma.booking.update({
            where: { id },
            data: { ...opts, lastError: null },
            include: withRooms,
        });
    }

    /**
     * Record the user's explicit acceptance of a quoted → prebook price change.
     * WBE requires this confirmation before booking may proceed.
     */
    async acceptPriceChange(id: string): Promise<BookingWithRooms> {
        return prisma.booking.update({
            where: { id },
            data: { priceChangeAcceptedAt: new Date(), status: BookingFlowStatus.prebooked },
            include: withRooms,
        });
    }

    /**
     * Move the booking into `booking` immediately before bookV2 is dispatched.
     *
     * Guarded on the current status so a booking already in flight or already
     * booked cannot be dispatched twice. Returns false if the transition was
     * refused, which the caller must treat as "do not call WBE".
     */
    async markDispatching(id: string, payload: Prisma.InputJsonValue): Promise<boolean> {
        const { count } = await prisma.booking.updateMany({
            where: { id, status: BookingFlowStatus.prebooked },
            data: { status: BookingFlowStatus.booking, bookRequestPayload: payload },
        });
        return count === 1;
    }

    /**
     * Persist a successful bookV2 result.
     *
     * A booking can come back already Vouchered — either because the option
     * was non-refundable (WBE vouchers those automatically) or because
     * IssueVoucher=true was sent — so voucheredAt is stamped here rather than
     * only in the explicit issueVoucher path.
     */
    async markBooked(
        id: string,
        snapshot: WbeBookingSnapshot,
        rawResponse?: Prisma.InputJsonValue,
    ): Promise<BookingWithRooms> {
        const alreadyVouchered = snapshot.wbeStatus === 'VCHR';
        return prisma.booking.update({
            where: { id },
            data: {
                ...snapshot,
                status: alreadyVouchered
                    ? BookingFlowStatus.vouchered
                    : BookingFlowStatus.booked,
                ...(alreadyVouchered ? { voucheredAt: new Date() } : {}),
                bookedAt: new Date(),
                lastSyncedAt: new Date(),
                bookResponsePayload: rawResponse,
                lastError: null,
            },
            include: withRooms,
        });
    }

    /**
     * Mark a booking as failed. `preserveDispatched` keeps the row in
     * `booking` instead, for the case where bookV2 gave an ambiguous result
     * and a reservation may still exist upstream awaiting reconciliation.
     */
    async markFailed(
        id: string,
        error: string,
        opts: { preserveDispatched?: boolean } = {},
    ): Promise<void> {
        await prisma.booking.update({
            where: { id },
            data: {
                status: opts.preserveDispatched
                    ? BookingFlowStatus.booking
                    : BookingFlowStatus.failed,
                lastError: error.slice(0, 2000),
            },
        });
    }

    /** Apply a BookingDetails snapshot, keeping local flow status in step. */
    async syncFromWbe(id: string, snapshot: WbeBookingSnapshot): Promise<BookingWithRooms> {
        const status = mapWbeStatusToFlowStatus(snapshot.wbeStatus);
        return prisma.booking.update({
            where: { id },
            data: {
                ...snapshot,
                ...(status ? { status } : {}),
                lastSyncedAt: new Date(),
            },
            include: withRooms,
        });
    }

    async markVouchered(
        id: string,
        snapshot: WbeBookingSnapshot,
    ): Promise<BookingWithRooms> {
        return prisma.booking.update({
            where: { id },
            data: {
                ...snapshot,
                status: BookingFlowStatus.vouchered,
                voucheredAt: new Date(),
                lastSyncedAt: new Date(),
            },
            include: withRooms,
        });
    }

    /**
     * Apply a CancelBookingV2 outcome. A PNDC result is not a completed
     * cancellation — it awaits manual confirmation on WBE's side — so it maps
     * to pending_cancellation and leaves cancelledAt unset.
     */
    async markCancelled(
        id: string,
        opts: { wbeStatus?: string; cancellationCharge?: number },
    ): Promise<BookingWithRooms> {
        const settled = opts.wbeStatus === 'CLX';
        return prisma.booking.update({
            where: { id },
            data: {
                wbeStatus: opts.wbeStatus,
                cancellationCharge: opts.cancellationCharge,
                status: settled
                    ? BookingFlowStatus.cancelled
                    : BookingFlowStatus.pending_cancellation,
                cancelledAt: settled ? new Date() : null,
                lastSyncedAt: new Date(),
            },
            include: withRooms,
        });
    }

    /**
     * Bookings whose status may still change upstream and therefore need
     * periodic re-sync (pending confirmation, or pending cancellation).
     */
    async findNeedingStatusSync(limit = 50): Promise<BookingWithRooms[]> {
        return prisma.booking.findMany({
            where: {
                bookingReference: { not: null },
                OR: [{ wbeStatus: 'PNDN' }, { wbeStatus: 'PNDC' }],
            },
            orderBy: { lastSyncedAt: 'asc' },
            take: limit,
            include: withRooms,
        });
    }

    /**
     * Refundable test bookings still live and past no deadline, used by the
     * certification runner to clean up after itself so the account is not left
     * holding reservations that would be charged at deadline.
     */
    async findCertificationBookingsToCancel(): Promise<BookingWithRooms[]> {
        return prisma.booking.findMany({
            where: {
                isCertificationTest: true,
                bookingReference: { not: null },
                nonRefundable: false,
                status: { in: [BookingFlowStatus.booked, BookingFlowStatus.vouchered] },
            },
            orderBy: { certificationScenario: 'asc' },
            include: withRooms,
        });
    }

    /** Certification bookings with a reference, for filling in WBE's document. */
    async listCertificationBookings(): Promise<BookingWithRooms[]> {
        return prisma.booking.findMany({
            where: { isCertificationTest: true },
            orderBy: [{ certificationScenario: 'asc' }, { createdAt: 'asc' }],
            include: withRooms,
        });
    }

    async list(opts: {
        page?: number;
        limit?: number;
        status?: BookingFlowStatus;
        requestId?: string;
        includeCertificationTests?: boolean;
    } = {}): Promise<{ items: BookingWithRooms[]; total: number }> {
        const page = Math.max(1, opts.page ?? 1);
        const limit = Math.min(100, Math.max(1, opts.limit ?? 20));

        const where: Prisma.BookingWhereInput = {
            ...(opts.status ? { status: opts.status } : {}),
            ...(opts.requestId ? { requestId: opts.requestId } : {}),
            // Certification traffic is excluded from business listings unless
            // explicitly asked for.
            ...(opts.includeCertificationTests ? {} : { isCertificationTest: false }),
        };

        const [items, total] = await Promise.all([
            prisma.booking.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: withRooms,
            }),
            prisma.booking.count({ where }),
        ]);

        return { items, total };
    }
}

/**
 * Map a WBE booking status onto our internal flow status.
 * Returns undefined for an unrecognised value so an unexpected code from WBE
 * leaves the local status untouched rather than silently mislabelling it.
 */
export function mapWbeStatusToFlowStatus(
    wbeStatus?: string,
): BookingFlowStatus | undefined {
    switch (wbeStatus) {
        case 'PNDN':
            return BookingFlowStatus.booked;
        case 'CNF':
            return BookingFlowStatus.booked;
        case 'VCHR':
            return BookingFlowStatus.vouchered;
        case 'CLX':
            return BookingFlowStatus.cancelled;
        case 'PNDC':
            return BookingFlowStatus.pending_cancellation;
        case 'RJ':
            return BookingFlowStatus.failed;
        default:
            return undefined;
    }
}

export default new BookingRepository();
