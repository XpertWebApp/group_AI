import { PrismaClient, BookingRequest } from '@prisma/client';

const prisma = new PrismaClient();

export class RequestRepository {
    async findAll() {
        return prisma.bookingRequest.findMany({
            orderBy: { createdAt: 'desc' },
        });
    }

    async findById(id: string) {
        return prisma.bookingRequest.findUnique({
            where: { id },
            include: { proposals: true },
        });
    }

    async updateStatus(id: string, status: string) {
        return prisma.bookingRequest.update({
            where: { id },
            data: { status, updatedAt: new Date() },
        });
    }
}

export default new RequestRepository();
