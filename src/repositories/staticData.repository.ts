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

    async getAllHotelCodes(): Promise<Set<string>> {
        const hotels = await prisma.hotel.findMany({
            select: { hotelCode: true },
        });
        return new Set(hotels.map((h) => h.hotelCode));
    }

    async createManyHotels(data: any[]) {
        return prisma.hotel.createMany({
            data,
            skipDuplicates: true,
        });
    }

    async updateHotel(hotelCode: string, data: any) {
        return prisma.hotel.update({
            where: { hotelCode },
            data,
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

    async clearHotelFacilityGroups(hotelCode: string, groupType?: string) {
        return prisma.hotelFacilityGroup.deleteMany({
            where: {
                hotelCode,
                ...(groupType ? { groupType } : {}),
            },
        });
    }

    async createHotelFacilityGroups(groups: Array<{ hotelCode: string; groupType: string; category?: string | null; facilities?: any }>) {
        if (groups.length === 0) return { count: 0 };
        return prisma.hotelFacilityGroup.createMany({
            data: groups.map((g) => ({
                hotelCode: g.hotelCode,
                groupType: g.groupType,
                category: g.category ?? null,
                facilities: g.facilities ?? null,
            })),
        });
    }

    async upsertLanguage(data: { code: string; name?: string | null }) {
        return prisma.language.upsert({
            where: { code: data.code },
            update: { name: data.name ?? null },
            create: { code: data.code, name: data.name ?? null },
        });
    }

    async upsertCurrency(data: { code: string; name?: string | null }) {
        return prisma.currency.upsert({
            where: { code: data.code },
            update: { name: data.name ?? null },
            create: { code: data.code, name: data.name ?? null },
        });
    }

    async upsertNationality(data: { code: string; name?: string | null }) {
        return prisma.nationality.upsert({
            where: { code: data.code },
            update: { name: data.name ?? null },
            create: { code: data.code, name: data.name ?? null },
        });
    }

    // --- Sync Job Management ---

    async createJob(data: { type: string; status: any; totalRecords?: number }) {
        return (prisma as any).syncJob.create({
            data: {
                ...data,
                startedAt: new Date(),
            },
        });
    }

    async updateJob(id: string, data: any) {
        return (prisma as any).syncJob.update({
            where: { id },
            data,
        });
    }

    async getInProgressJob(type: string) {
        return (prisma as any).syncJob.findFirst({
            where: { type, status: 'IN_PROGRESS' },
            orderBy: { startedAt: 'desc' },
        });
    }

    async getLatestJob(type: string) {
        return (prisma as any).syncJob.findFirst({
            where: { type },
            orderBy: { startedAt: 'desc' },
        });
    }
}

export default new StaticDataRepository();
