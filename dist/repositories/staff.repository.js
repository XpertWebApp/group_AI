"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaffRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const staffSelect = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    isActive: true,
    lastLoginAt: true,
    createdAt: true,
    role: { select: { name: true } },
};
class StaffRepository {
    async findAll(opts) {
        const page = opts.page ?? 1;
        const limit = opts.limit ?? 20;
        const skip = (page - 1) * limit;
        const where = {};
        if (opts.search) {
            where.OR = [
                { firstName: { contains: opts.search, mode: 'insensitive' } },
                { lastName: { contains: opts.search, mode: 'insensitive' } },
                { email: { contains: opts.search, mode: 'insensitive' } },
            ];
        }
        if (opts.status === 'active') {
            where.isActive = true;
        }
        else if (opts.status === 'blocked') {
            where.isActive = false;
        }
        const [data, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: staffSelect,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.user.count({ where }),
        ]);
        return { data, total, page, limit };
    }
    async findById(id) {
        return prisma.user.findUnique({
            where: { id },
            select: staffSelect,
        });
    }
    async create(data) {
        return prisma.user.create({
            data,
            select: staffSelect,
        });
    }
    async updateStatus(id, isActive) {
        const updateData = { isActive };
        if (!isActive) {
            updateData.refreshToken = null;
        }
        return prisma.user.update({
            where: { id },
            data: updateData,
            select: staffSelect,
        });
    }
    async updatePassword(id, hashedPassword) {
        await prisma.user.update({
            where: { id },
            data: {
                password: hashedPassword,
                refreshToken: null,
            },
        });
    }
    async delete(id) {
        await prisma.user.delete({ where: { id } });
    }
    async getUserRole() {
        const role = await prisma.userRole.findUnique({ where: { name: 'USER' } });
        if (!role) {
            throw { status: 500, message: 'USER role not found in database', code: 'INTERNAL_ERROR' };
        }
        return { id: role.id, name: role.name };
    }
    async countAll() {
        return prisma.user.count();
    }
}
exports.StaffRepository = StaffRepository;
exports.default = new StaffRepository();
//# sourceMappingURL=staff.repository.js.map