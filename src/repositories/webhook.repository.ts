import { PrismaClient, BookingRequest } from '@prisma/client';

const prisma = new PrismaClient();

export class WebhookRepository {
    async createBookingRequest(data: any): Promise<BookingRequest> {
        return prisma.bookingRequest.create({
            data,
        });
    }

    async findById(id: string): Promise<BookingRequest | null> {
        return prisma.bookingRequest.findUnique({
            where: { id },
        });
    }
}

export default new WebhookRepository();
