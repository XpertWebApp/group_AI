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

    /**
     * Get a single supplier limit by supplier code.
     */
    async findByCode(supplierCode: string) {
        return prisma.supplierLimit.findUnique({ where: { supplierCode } });
    }

    /**
     * Update a supplier limit's maxRooms (and optionally other fields).
     */
    async update(
        supplierCode: string,
        data: { maxRooms?: number; groupsAllowed?: boolean; providerName?: string; accCode?: string; notes?: string },
    ) {
        return prisma.supplierLimit.update({
            where: { supplierCode },
            data,
        });
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
