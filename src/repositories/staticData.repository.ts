import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class StaticDataRepository {
    async upsertDestination(data: any) {
        return prisma.destination.upsert({
            where: { id: data.id },
            update: data,
            create: data,
        });
    }

    async upsertHotel(data: any) {
        return prisma.hotel.upsert({
            where: { hotelCode: data.hotelCode },
            update: data,
            create: data,
        });
    }

    async upsertFacility(data: any) {
        return prisma.facility.upsert({
            where: { id: data.id },
            update: data,
            create: data,
        });
    }

    async clearHotelFacilities(hotelCode: string) {
        return prisma.hotelFacility.deleteMany({
            where: { hotelCode },
        });
    }

    async createHotelFacility(data: any) {
        return prisma.hotelFacility.create({
            data,
        });
    }

    async upsertHotelImage(data: any) {
        // Hotel images don't have a natural PK from API sometimes, 
        // we use hotelCode + imageKey if possible. 
        // In our schema, we have a UUID id.
        const existing = await prisma.hotelImage.findFirst({
            where: { hotelCode: data.hotelCode, imageKey: data.imageKey },
        });

        if (existing) {
            return prisma.hotelImage.update({
                where: { id: existing.id },
                data,
            });
        }

        return prisma.hotelImage.create({
            data,
        });
    }

    async getHotelsNeedingDetails() {
        return prisma.hotel.findMany({
            where: {
                OR: [
                    { detailsFetchedAt: null },
                    {
                        lastSyncedAt: {
                            lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // older than 7 days
                        },
                    },
                ],
            },
            select: { hotelCode: true, hotelDetailsUrl: true },
        });
    }
}

export default new StaticDataRepository();
