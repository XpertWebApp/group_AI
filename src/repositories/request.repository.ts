import { PrismaClient, BookingRequestStatus, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export interface ListRequestsOptions {
    page?: number;
    limit?: number;
    search?: string;
    status?: BookingRequestStatus;
    /**
     * Legacy date window — applied to `checkin_date`. Kept for back-compat
     * with older callers. New code should use `createdFrom`/`createdTo`.
     */
    dateFrom?: string;
    dateTo?: string;
    /**
     * Explicit window on `created_at`. Drives the dashboard's
     * "This Month / Quarter / Year" filter chip — filtering by when the
     * request was created, not by trip dates.
     */
    createdFrom?: string;
    createdTo?: string;
    sortBy?: 'createdAt' | 'checkinDate' | 'referenceNumber';
    sortOrder?: 'asc' | 'desc';
}

/** Full field selection for detail / summary views — all 4 Figma steps included. */
const FULL_SELECT = {
    id: true,
    referenceNumber: true,
    // Step 1 – Trip Details
    destinationId: true,
    destinationName: true,
    checkinDate: true,
    checkoutDate: true,
    nights: true,
    starRating: true,
    starRatings: true,
    budgetRange: true,
    budget: true,
    groupType: true,
    groupSize: true,
    averageAge: true,
    currencyCode: true,
    nationalityCode: true,
    // Step 2 – Room & Accommodations
    rooms: true,
    breakfastPreference: true,
    hotelLocation: true,
    specialRequirements: true,
    // Step 3 – Customer Details
    companyName: true,
    firstName: true,
    lastName: true,
    contactName: true,
    contactEmail: true,
    contactPhone: true,
    contactPhoneCountryCode: true,
    guestListFileKey: true,
    customerNotes: true,
    odooContactId: true,
    // Step 4 – Policies
    termsAndConditions: true,
    cancellationConditions: true,
    // System
    source: true,
    status: true,
    searchPhase: true,
    searchPaginationCursor: true,
    processed: true,
    processedAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

/** Lightweight selection for the Group Requests list table. */
const LIST_SELECT = {
    id: true,
    referenceNumber: true,
    companyName: true,
    firstName: true,
    lastName: true,
    contactName: true,
    destinationName: true,
    checkinDate: true,
    checkoutDate: true,
    nights: true,
    groupSize: true,
    groupType: true,
    averageAge: true,
    rooms: true,
    status: true,
    createdAt: true,
    odooContactId: true,
    assignedUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
    },
    proposals: {
        select: {
            id: true,
            status: true,
            totalBuy: true,
            totalSell: true,
            sentAt: true,
        },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
    },
} as const;

export class RequestRepository {
    /**
     * Paginated + searchable list for the Group Requests page.
     * Supports search by customer name / destination / offer #ID, status filter, date range.
     */
    async findAll(opts: ListRequestsOptions = {}) {
        const {
            page = 1,
            limit = 20,
            search,
            status,
            dateFrom,
            dateTo,
            createdFrom,
            createdTo,
            sortBy = 'createdAt',
            sortOrder = 'desc',
        } = opts;

        const where: Prisma.BookingRequestWhereInput = {};

        if (status) where.status = status;

        // Legacy: filter by trip check-in date. Surface is unchanged so
        // existing callers keep working. New dashboard filter chip
        // ("This Month / Quarter / Year") uses createdFrom/createdTo
        // below instead because it's a "when was this request created"
        // semantic, not a "when does the trip start" one.
        if (dateFrom || dateTo) {
            where.checkinDate = {
                ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                ...(dateTo ? { lte: new Date(dateTo) } : {}),
            };
        }

        if (createdFrom || createdTo) {
            where.createdAt = {
                ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
                ...(createdTo ? { lte: new Date(createdTo) } : {}),
            };
        }

        if (search) {
            const refNum = parseInt(search.replace('#', ''), 10);
            where.OR = [
                { companyName: { contains: search, mode: 'insensitive' } },
                { destinationName: { contains: search, mode: 'insensitive' } },
                { contactEmail: { contains: search, mode: 'insensitive' } },
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                ...(!isNaN(refNum) ? [{ referenceNumber: refNum }] : []),
            ];
        }

        const [total, items] = await Promise.all([
            prisma.bookingRequest.count({ where }),
            prisma.bookingRequest.findMany({
                where,
                select: LIST_SELECT,
                orderBy: { [sortBy]: sortOrder },
                skip: (page - 1) * limit,
                take: limit,
            }),
        ]);

        return {
            data: items,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }

    async findById(id: string) {
        return prisma.bookingRequest.findUnique({
            where: { id },
            select: {
                ...FULL_SELECT,
                proposals: {
                    include: { hotels: { where: { deletedAt: null } }, services: true },
                },
                attachments: true,
            },
        });
    }

    async findByReferenceNumber(ref: number) {
        return prisma.bookingRequest.findUnique({
            where: { referenceNumber: ref },
            select: {
                ...FULL_SELECT,
                proposals: {
                    include: { hotels: { where: { deletedAt: null } }, services: true },
                },
                attachments: true,
            },
        });
    }

    async findSummary(id: string) {
        return prisma.bookingRequest.findUnique({
            where: { id },
            select: {
                ...FULL_SELECT,
                proposals: {
                    select: {
                        id: true,
                        status: true,
                        totalBuy: true,
                        totalSell: true,
                        markupSettings: true,
                        sentAt: true,
                        createdAt: true,
                    },
                },
            },
        });
    }

    async create(data: Prisma.BookingRequestCreateInput) {
        return prisma.bookingRequest.create({
            data,
            select: FULL_SELECT,
        });
    }

    async update(id: string, data: Prisma.BookingRequestUpdateInput) {
        return prisma.bookingRequest.update({
            where: { id },
            data,
            select: FULL_SELECT,
        });
    }

    async updateStatus(id: string, status: BookingRequestStatus) {
        return prisma.bookingRequest.update({
            where: { id },
            data: { status },
            select: { id: true, referenceNumber: true, status: true },
        });
    }

    /**
     * Update the search-phase signal read by the polling frontend.
     * Values: 'in_progress' (search active), 'settled' (search done with
     * results), 'exhausted' (search done with zero viable hotels — request
     * flagged for manual handling). Best-effort: never throws, errors logged
     * elsewhere — a missed phase update should not abort the search itself.
     */
    async updateSearchPhase(id: string, phase: 'in_progress' | 'settled' | 'exhausted') {
        return prisma.bookingRequest.update({
            where: { id },
            data: { searchPhase: phase },
            select: { id: true, searchPhase: true },
        });
    }

    /**
     * Lightweight read for the polling /hotel-search/status endpoint.
     * Avoids the FULL_SELECT findById join cost (proposals + hotels + services + attachments)
     * on a hot path that's hit every 5 seconds while a search is in flight.
     */
    async getSearchPhase(id: string): Promise<'in_progress' | 'settled' | 'exhausted' | null> {
        const row = await prisma.bookingRequest.findUnique({
            where: { id },
            select: { searchPhase: true },
        });
        return (row?.searchPhase as 'in_progress' | 'settled' | 'exhausted' | null | undefined) ?? null;
    }

    /**
     * Read the persisted pagination cursor. NULL when no search has settled
     * yet, the search ended in 'exhausted' (cursor explicitly cleared), or
     * the request pre-dates the Search More feature.
     *
     * Shape: { usedDestinationId, starRatings, totalCandidates, nextOffset }.
     */
    async getSearchPaginationCursor(id: string): Promise<{
        usedDestinationId: number;
        starRatings: number[];
        totalCandidates: number;
        nextOffset: number;
    } | null> {
        const row = await prisma.bookingRequest.findUnique({
            where: { id },
            select: { searchPaginationCursor: true },
        });
        const v = row?.searchPaginationCursor as any;
        if (!v || typeof v !== 'object') return null;
        // Defensive: validate the four fields we depend on. A malformed row
        // (manual DB edit, schema drift) yields null instead of crashing.
        if (
            typeof v.usedDestinationId !== 'number' ||
            !Array.isArray(v.starRatings) ||
            typeof v.totalCandidates !== 'number' ||
            typeof v.nextOffset !== 'number'
        ) {
            return null;
        }
        return {
            usedDestinationId: v.usedDestinationId,
            starRatings: v.starRatings,
            totalCandidates: v.totalCandidates,
            nextOffset: v.nextOffset,
        };
    }

    /**
     * Persist (or clear) the pagination cursor on the BookingRequest.
     * Called by the post-probe watcher just before broadcasting
     * searchSettled, and again by the Search More mini-watcher to advance
     * `nextOffset` after each user-triggered batch. Pass `null` to clear
     * (used when the destination has been fully drained).
     */
    async setSearchPaginationCursor(
        id: string,
        cursor: {
            usedDestinationId: number;
            starRatings: number[];
            totalCandidates: number;
            nextOffset: number;
        } | null,
    ) {
        return prisma.bookingRequest.update({
            where: { id },
            data: { searchPaginationCursor: cursor === null ? Prisma.JsonNull : (cursor as any) },
            select: { id: true },
        });
    }

    /**
     * Find booking requests whose search has been "in_progress" longer than `staleAfterMinutes`.
     * Used by the startup sweeper to recover stalled searches whose watcher died
     * (server restart, silent crash, etc.) and left the phase column stuck.
     * Returns only the columns the sweeper needs — avoids the heavy FULL_SELECT.
     */
    async findStalledInProgressSearches(staleAfterMinutes = 5) {
        const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000);
        return prisma.bookingRequest.findMany({
            where: {
                searchPhase: 'in_progress',
                updatedAt: { lt: cutoff },
            },
            select: {
                id: true,
                referenceNumber: true,
                destinationId: true,
                destinationName: true,
                starRating: true,
                status: true,
                updatedAt: true,
            },
        });
    }

    /**
     * Atomically claim ownership if the request is currently unassigned.
     * Uses a conditional UPDATE so concurrent callers race at the DB level —
     * exactly one winner, losers see `claimed: false` with the current ownerId.
     */
    async claimOwnershipIfUnassigned(
        requestId: string,
        userId: string,
    ): Promise<{ claimed: boolean; ownerId: string | null }> {
        const result = await prisma.bookingRequest.updateMany({
            where: { id: requestId, assignedUserId: null },
            data: { assignedUserId: userId },
        });
        if (result.count === 1) return { claimed: true, ownerId: userId };
        const row = await prisma.bookingRequest.findUnique({
            where: { id: requestId },
            select: { assignedUserId: true },
        });
        return { claimed: false, ownerId: row?.assignedUserId ?? null };
    }

    async findOwner(requestId: string) {
        const row = await prisma.bookingRequest.findUnique({
            where: { id: requestId },
            select: {
                assignedUser: {
                    select: { id: true, firstName: true, lastName: true, email: true },
                },
            },
        });
        return row?.assignedUser ?? null;
    }

    // ── Dashboard aggregates ─────────────────────────────────────────────────

    async countAll() {
        return prisma.bookingRequest.count();
    }

    async countByStatus(status: BookingRequestStatus) {
        return prisma.bookingRequest.count({ where: { status } });
    }

    async countAllSince(since: Date) {
        return prisma.bookingRequest.count({ where: { createdAt: { gte: since } } });
    }

    async countByStatusSince(status: BookingRequestStatus, since: Date) {
        return prisma.bookingRequest.count({ where: { status, createdAt: { gte: since } } });
    }

    async getRecentOffers(limit = 10) {
        return prisma.bookingRequest.findMany({
            select: LIST_SELECT,
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
}

export default new RequestRepository();
