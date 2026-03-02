import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class HotelRepository {
    async search(options: {
        q?: string;
        destinationId?: number;
        starRating?: number;
        limit?: number;
        offset?: number;
    }) {
        const { q, destinationId, starRating, limit = 20, offset = 0 } = options;

        return prisma.hotel.findMany({
            where: {
                ...(q && {
                    OR: [
                        { name: { contains: q, mode: 'insensitive' } },
                        { addressCity: { contains: q, mode: 'insensitive' } },
                    ],
                }),
                ...(destinationId !== undefined && { destinationId }),
                ...(starRating !== undefined && { starRating: { gte: starRating } }),
            },
            select: {
                hotelCode: true,
                name: true,
                destinationId: true,
                starRating: true,
                addressCity: true,
                addressCountry: true,
                supplierCode: true,
                category: true,
            },
            orderBy: [{ name: 'asc' }],
            take: limit,
            skip: offset,
        });
    }
}

export default new HotelRepository();
