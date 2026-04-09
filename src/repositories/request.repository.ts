import { PrismaClient, BookingRequestStatus, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export interface ListRequestsOptions {
    page?: number;
    limit?: number;
    search?: string;
    status?: BookingRequestStatus;
    dateFrom?: string;
    dateTo?: string;
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
    budgetRange: true,
    budget: true,
    groupType: true,
    groupSize: true,
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
    // Step 4 – Policies
    termsAndConditions: true,
    cancellationConditions: true,
    // System
    source: true,
    status: true,
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
    rooms: true,
    status: true,
    createdAt: true,
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
            sortBy = 'createdAt',
            sortOrder = 'desc',
        } = opts;

        const where: Prisma.BookingRequestWhereInput = {};

        if (status) where.status = status;

        if (dateFrom || dateTo) {
            where.checkinDate = {
                ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                ...(dateTo ? { lte: new Date(dateTo) } : {}),
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
