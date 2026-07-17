import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface SupplierLimitRow {
    id: string;
    supplierCode: string;
    providerName: string;
    accCode: string | null;
    maxRooms: number;
    groupsAllowed: boolean;
    notes: string | null;
    updatedAt: Date;
    createdAt: Date;
}

export class SupplierLimitsRepository {
    /**
     * List all supplier limits with optional search and pagination.
     */
    async findAll(opts: {
        search?: string;
        page?: number;
        limit?: number;
    }): Promise<{ data: SupplierLimitRow[]; total: number; page: number; limit: number }> {
        const page = opts.page ?? 1;
        const limit = opts.limit ?? 20;
        const skip = (page - 1) * limit;

        const where = opts.search
            ? {
                  OR: [
                      { supplierCode: { contains: opts.search, mode: 'insensitive' as const } },
                      { providerName: { contains: opts.search, mode: 'insensitive' as const } },
                      { accCode: { contains: opts.search, mode: 'insensitive' as const } },
                  ],
              }
            : {};

        const [data, total] = await Promise.all([
            prisma.supplierLimit.findMany({
                where,
                orderBy: { supplierCode: 'asc' },
                skip,
                take: limit,
            }),
            prisma.supplierLimit.count({ where }),
        ]);

        return { data, total, page, limit };
    }

    /** UUID v4-ish check to tell an id apart from a supplier code. */
    private isUuid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    /** Get a single row by primary-key id. */
    async findById(id: string) {
        return prisma.supplierLimit.findUnique({ where: { id } });
    }

    /**
     * Get a single row by supplier code. Codes are no longer unique, so this
     * returns the first match (used for legacy lookups / matching).
     */
    async findByCode(supplierCode: string) {
        return prisma.supplierLimit.findFirst({ where: { supplierCode } });
    }

    /** Resolve a row by id (if the value looks like a UUID) or by supplier code. */
    async findByIdOrCode(idOrCode: string) {
        return this.isUuid(idOrCode) ? this.findById(idOrCode) : this.findByCode(idOrCode);
    }

    /** Create a new supplier limit row. */
    async create(data: {
        supplierCode: string;
        providerName: string;
        accCode?: string | null;
        maxRooms?: number;
        groupsAllowed?: boolean;
        notes?: string | null;
    }) {
        return prisma.supplierLimit.create({ data });
    }

    /** Update a supplier limit row by its primary-key id. */
    async update(
        id: string,
        data: {
            supplierCode?: string;
            maxRooms?: number;
            groupsAllowed?: boolean;
            providerName?: string;
            accCode?: string | null;
            notes?: string | null;
        },
    ) {
        return prisma.supplierLimit.update({ where: { id }, data });
    }

    /** Delete a supplier limit row by its primary-key id. */
    async delete(id: string) {
        return prisma.supplierLimit.delete({ where: { id } });
    }

    /**
     * Get all supplier limits as a map (for use in hotelSearch service).
     */
    async getAllAsMap(): Promise<
        Record<string, { maxRooms: number; groupsAllowed: boolean; providerName: string }>
    > {
        const rows = await prisma.supplierLimit.findMany();
        const result: Record<string, { maxRooms: number; groupsAllowed: boolean; providerName: string }> = {};
        for (const row of rows) {
            result[row.supplierCode] = {
                maxRooms: row.maxRooms,
                groupsAllowed: row.groupsAllowed,
                providerName: row.providerName,
            };
        }
        return result;
    }

    /**
     * Get last updated timestamp for the supplier limits section.
     */
    async getLastUpdated(): Promise<Date | null> {
        const row = await prisma.supplierLimit.findFirst({
            orderBy: { updatedAt: 'desc' },
            select: { updatedAt: true },
        });
        return row?.updatedAt ?? null;
    }
}

export default new SupplierLimitsRepository();
