import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface StaffRow {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    isActive: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
    role: { name: string };
}

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

export class StaffRepository {
    async findAll(opts: {
        search?: string;
        status?: 'active' | 'blocked';
        page?: number;
        limit?: number;
    }): Promise<{ data: StaffRow[]; total: number; page: number; limit: number }> {
        const page = opts.page ?? 1;
        const limit = opts.limit ?? 20;
        const skip = (page - 1) * limit;

        const where: any = {};

        if (opts.search) {
            where.OR = [
                { firstName: { contains: opts.search, mode: 'insensitive' } },
                { lastName: { contains: opts.search, mode: 'insensitive' } },
                { email: { contains: opts.search, mode: 'insensitive' } },
            ];
        }

        if (opts.status === 'active') {
            where.isActive = true;
        } else if (opts.status === 'blocked') {
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

    async findById(id: string): Promise<StaffRow | null> {
        return prisma.user.findUnique({
            where: { id },
            select: staffSelect,
        });
    }

    async create(data: {
        email: string;
        password: string;
        firstName: string;
        lastName: string | null;
        roleId: string;
    }): Promise<StaffRow> {
        return prisma.user.create({
            data,
            select: staffSelect,
        });
    }

    async updateStatus(id: string, isActive: boolean): Promise<StaffRow> {
        const updateData: any = { isActive };
        if (!isActive) {
            updateData.refreshToken = null;
        }
        return prisma.user.update({
            where: { id },
            data: updateData,
            select: staffSelect,
        });
    }

    async updatePassword(id: string, hashedPassword: string): Promise<void> {
        await prisma.user.update({
            where: { id },
            data: {
                password: hashedPassword,
                refreshToken: null,
            },
        });
    }

    async delete(id: string): Promise<void> {
        await prisma.user.delete({ where: { id } });
    }

    async getUserRole(): Promise<{ id: string; name: string }> {
        const role = await prisma.userRole.findUnique({ where: { name: 'USER' } });
        if (!role) {
            throw { status: 500, message: 'USER role not found in database', code: 'INTERNAL_ERROR' };
        }
        return { id: role.id, name: role.name };
    }

    async countAll(): Promise<number> {
        return prisma.user.count();
    }
}

export default new StaffRepository();
