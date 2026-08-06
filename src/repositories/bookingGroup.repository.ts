import { PrismaClient, BookingFlowStatus, BookingGroupStatus } from '@prisma/client';

const prisma = new PrismaClient();

/** A group with its child bookings attached. */
const withBookings = {
    bookings: {
        orderBy: { createdAt: 'asc' as const },
    },
} as const;

export type BookingGroupWithBookings = Awaited<
    ReturnType<typeof prisma.bookingGroup.findFirstOrThrow<{ include: typeof withBookings }>>
>;

export interface CreateBookingGroupData {
    groupReference: string;
    requestId: string;
    proposalId?: string;
    hotelCode: string;
    hotelName?: string;
    checkInDate: Date;
    checkOutDate: Date;
    nights: number;
    roomsRequested: number;
    quotedTotal?: number;
    currency?: string;
    createdById?: string;
}

/**
 * Generate the reference shown to the customer for a whole group.
 *
 * Deliberately distinct in shape from `SETT-…` agency references, which are
 * per-supplier and internal: quoting one of those to a customer would name only
 * a slice of their stay.
 */
export function generateGroupReference(prefix = 'SETTG'): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `${prefix}-${stamp}-${rand}`;
}

/**
 * A booking counts towards a group's confirmed total once WBE has given it a
 * reference. `booked` and `vouchered` both qualify; `booking` does not, because
 * a dispatched call with no response yet may still fail.
 */
const CONFIRMED_STATES: BookingFlowStatus[] = [
    BookingFlowStatus.booked,
    BookingFlowStatus.vouchered,
];

/** States that mean this slice will never contribute rooms. */
const DEAD_STATES: BookingFlowStatus[] = [
    BookingFlowStatus.failed,
    BookingFlowStatus.cancelled,
];

export class BookingGroupRepository {
    async create(data: CreateBookingGroupData): Promise<BookingGroupWithBookings> {
        return prisma.bookingGroup.create({
            data: { ...data, status: BookingGroupStatus.pending },
            include: withBookings,
        });
    }

    async findById(id: string): Promise<BookingGroupWithBookings | null> {
        return prisma.bookingGroup.findUnique({ where: { id }, include: withBookings });
    }

    async findByReference(groupReference: string): Promise<BookingGroupWithBookings | null> {
        return prisma.bookingGroup.findUnique({ where: { groupReference }, include: withBookings });
    }

    async findByRequest(requestId: string): Promise<BookingGroupWithBookings[]> {
        return prisma.bookingGroup.findMany({
            where: { requestId },
            include: withBookings,
            orderBy: { createdAt: 'desc' },
        });
    }

    /** Attach an already-created booking to a group as one slice of it. */
    async attachBooking(groupId: string, bookingId: string, roomsInSlice: number): Promise<void> {
        await prisma.booking.update({
            where: { id: bookingId },
            data: { groupId, roomsInSlice },
        });
    }

    /**
     * Recompute the group's aggregate state from its children.
     *
     * Derived rather than set directly, because the interesting states are
     * conclusions about the whole set — "part of this group is confirmed and
     * part will never be" is not something any single slice knows.
     *
     * Rooms are counted from `roomsInSlice` rather than from the room rows: a
     * slice that failed before dispatch has no rooms persisted, and we still
     * need to know how many it was carrying to report the shortfall.
     */
    async recomputeStatus(groupId: string): Promise<BookingGroupWithBookings> {
        const group = await prisma.bookingGroup.findUniqueOrThrow({
            where: { id: groupId },
            include: withBookings,
        });

        const slices = group.bookings;
        const confirmed = slices.filter((b) => CONFIRMED_STATES.includes(b.status));
        const dead = slices.filter((b) => DEAD_STATES.includes(b.status));
        const settled = confirmed.length + dead.length;

        const roomsConfirmed = confirmed.reduce((sum, b) => sum + (b.roomsInSlice ?? 0), 0);
        const totalBooked = confirmed.reduce((sum, b) => sum + Number(b.totalPrice ?? 0), 0);

        let status: BookingGroupStatus;
        if (slices.length === 0 || settled === 0) {
            // Nothing has come back yet. `booking` once anything was dispatched,
            // so a group mid-flight is not reported as untouched.
            status = slices.some((b) => b.status !== BookingFlowStatus.draft)
                ? BookingGroupStatus.booking
                : BookingGroupStatus.pending;
        } else if (settled < slices.length) {
            status = BookingGroupStatus.booking;
        } else if (confirmed.length === 0) {
            // Every slice settled and none confirmed. Distinguish a group that
            // was booked and then cancelled from one that never took: the first
            // is a completed intention, the second is a failure to report.
            status = slices.every((b) => b.status === BookingFlowStatus.cancelled)
                ? BookingGroupStatus.cancelled
                : BookingGroupStatus.failed;
        } else if (roomsConfirmed >= group.roomsRequested) {
            status = BookingGroupStatus.confirmed;
        } else {
            // Rooms are held but the group is short. This is the state an
            // operator has to act on, and the one that must never be rounded up
            // to `confirmed`.
            status = BookingGroupStatus.partial;
        }

        const shortfall = group.roomsRequested - roomsConfirmed;
        const shortfallNote =
            status === BookingGroupStatus.partial
                ? buildShortfallNote(shortfall, dead)
                : null;

        return prisma.bookingGroup.update({
            where: { id: groupId },
            data: {
                status,
                roomsConfirmed,
                totalBooked: confirmed.length > 0 ? totalBooked : null,
                shortfallNote,
                completedAt:
                    status === BookingGroupStatus.confirmed ? (group.completedAt ?? new Date()) : null,
                cancelledAt:
                    status === BookingGroupStatus.cancelled ? (group.cancelledAt ?? new Date()) : null,
            },
            include: withBookings,
        });
    }

    /** Groups needing an operator: rooms are held but the group is short. */
    async findPartial(limit = 50): Promise<BookingGroupWithBookings[]> {
        return prisma.bookingGroup.findMany({
            where: { status: BookingGroupStatus.partial },
            include: withBookings,
            orderBy: { createdAt: 'asc' },
            take: limit,
        });
    }

    async list(params: {
        page: number;
        limit: number;
        status?: BookingGroupStatus;
        requestId?: string;
    }): Promise<{ items: BookingGroupWithBookings[]; total: number }> {
        const where = {
            ...(params.status ? { status: params.status } : {}),
            ...(params.requestId ? { requestId: params.requestId } : {}),
        };

        const [items, total] = await Promise.all([
            prisma.bookingGroup.findMany({
                where,
                include: withBookings,
                orderBy: { createdAt: 'desc' },
                skip: (params.page - 1) * params.limit,
                take: params.limit,
            }),
            prisma.bookingGroup.count({ where }),
        ]);

        return { items, total };
    }
}

/**
 * Describe the shortfall for whoever has to fix it — which supplier refused and
 * how many rooms are still needed, not a generic "booking incomplete".
 */
function buildShortfallNote(
    shortfall: number,
    dead: Array<{ supplierCode: string | null; lastError: string | null }>,
): string {
    const causes = dead
        .filter((b) => b.lastError)
        .map((b) => `${b.supplierCode ?? 'unknown supplier'}: ${b.lastError}`);

    const head = `${shortfall} room(s) short of the requested total.`;
    return causes.length > 0 ? `${head} ${causes.join('; ')}` : head;
}

export default new BookingGroupRepository();
