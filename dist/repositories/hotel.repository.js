"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotelRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class HotelRepository {
    async findByCode(hotelCode) {
        return prisma.hotel.findUnique({
            where: { hotelCode },
            select: {
                hotelCode: true,
                name: true,
                starRating: true,
                address: true,
                addressCity: true,
                addressCountry: true,
                latitude: true,
                longitude: true,
                totalRooms: true,
                propertyType: true,
                category: true,
                metadata: true,
                hotelDetailsUrl: true,
                detailsFetchedAt: true,
            },
        });
    }
    async search(options) {
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
exports.HotelRepository = HotelRepository;
exports.default = new HotelRepository();
