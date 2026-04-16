"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupplierLimitsRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class SupplierLimitsRepository {
    /**
     * List all supplier limits with optional search and pagination.
     */
    async findAll(opts) {
        const page = opts.page ?? 1;
        const limit = opts.limit ?? 20;
        const skip = (page - 1) * limit;
        const where = opts.search
            ? {
                OR: [
                    { supplierCode: { contains: opts.search, mode: 'insensitive' } },
                    { providerName: { contains: opts.search, mode: 'insensitive' } },
                    { accCode: { contains: opts.search, mode: 'insensitive' } },
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
    async findByCode(supplierCode) {
        return prisma.supplierLimit.findUnique({ where: { supplierCode } });
    }
    /**
     * Update a supplier limit's maxRooms (and optionally other fields).
     */
    async update(supplierCode, data) {
        return prisma.supplierLimit.update({
            where: { supplierCode },
            data,
        });
    }
    /**
     * Get all supplier limits as a map (for use in hotelSearch service).
     */
    async getAllAsMap() {
        const rows = await prisma.supplierLimit.findMany();
        const result = {};
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
    async getLastUpdated() {
        const row = await prisma.supplierLimit.findFirst({
            orderBy: { updatedAt: 'desc' },
            select: { updatedAt: true },
        });
        return row?.updatedAt ?? null;
    }
}
exports.SupplierLimitsRepository = SupplierLimitsRepository;
exports.default = new SupplierLimitsRepository();
