"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaticDataRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class StaticDataRepository {
    async upsertDestination(data) {
        return prisma.destination.upsert({
            where: { id: data.id },
            update: data,
            create: data,
        });
    }
    async upsertHotel(data) {
        return prisma.hotel.upsert({
            where: { hotelCode: data.hotelCode },
            update: data,
            create: data,
        });
    }
    async getAllHotelCodes() {
        const hotels = await prisma.hotel.findMany({
            select: { hotelCode: true },
        });
        return new Set(hotels.map((h) => h.hotelCode));
    }
    async createManyHotels(data) {
        return prisma.hotel.createMany({
            data,
            skipDuplicates: true,
        });
    }
    async updateHotel(hotelCode, data) {
        return prisma.hotel.update({
            where: { hotelCode },
            data,
        });
    }
    async upsertFacility(data) {
        return prisma.facility.upsert({
            where: { id: data.id },
            update: data,
            create: data,
        });
    }
    async clearHotelFacilities(hotelCode) {
        return prisma.hotelFacility.deleteMany({
            where: { hotelCode },
        });
    }
    async createHotelFacility(data) {
        return prisma.hotelFacility.create({
            data,
        });
    }
    async upsertHotelImage(data) {
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
    async clearHotelFacilityGroups(hotelCode, groupType) {
        return prisma.hotelFacilityGroup.deleteMany({
            where: {
                hotelCode,
                ...(groupType ? { groupType } : {}),
            },
        });
    }
    async createHotelFacilityGroups(groups) {
        if (groups.length === 0)
            return { count: 0 };
        return prisma.hotelFacilityGroup.createMany({
            data: groups.map((g) => ({
                hotelCode: g.hotelCode,
                groupType: g.groupType,
                category: g.category ?? null,
                facilities: g.facilities ?? null,
            })),
        });
    }
    async upsertLanguage(data) {
        return prisma.language.upsert({
            where: { code: data.code },
            update: { name: data.name ?? null },
            create: { code: data.code, name: data.name ?? null },
        });
    }
    async upsertCurrency(data) {
        return prisma.currency.upsert({
            where: { code: data.code },
            update: { name: data.name ?? null },
            create: { code: data.code, name: data.name ?? null },
        });
    }
    async upsertNationality(data) {
        return prisma.nationality.upsert({
            where: { code: data.code },
            update: { name: data.name ?? null },
            create: { code: data.code, name: data.name ?? null },
        });
    }
    // --- Sync Job Management ---
    async createJob(data) {
        return prisma.syncJob.create({
            data: {
                ...data,
                startedAt: new Date(),
            },
        });
    }
    async updateJob(id, data) {
        return prisma.syncJob.update({
            where: { id },
            data,
        });
    }
    async getInProgressJob(type) {
        return prisma.syncJob.findFirst({
            where: { type, status: 'IN_PROGRESS' },
            orderBy: { startedAt: 'desc' },
        });
    }
    async getLatestJob(type) {
        return prisma.syncJob.findFirst({
            where: { type },
            orderBy: { startedAt: 'desc' },
        });
    }
}
exports.StaticDataRepository = StaticDataRepository;
exports.default = new StaticDataRepository();
