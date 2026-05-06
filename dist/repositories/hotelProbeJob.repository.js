"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotelProbeJobRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class HotelProbeJobRepository {
    async create(data) {
        return prisma.hotelProbeJob.create({
            data: {
                id: data.id,
                searchRequestId: data.searchRequestId,
                hotelCode: data.hotelCode,
                requestedRooms: data.requestedRooms,
                probeLimit: data.probeLimit,
                searchKind: data.searchKind ?? 'main',
                alternativeReason: data.alternativeReason ?? null,
            },
        });
    }
    async setRunning(id) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: client_1.HotelProbeJobStatus.RUNNING,
                startedAt: new Date(),
                attempts: { increment: 1 },
            },
        });
    }
    async updateProbing(id, data) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: client_1.HotelProbeJobStatus.PROBING,
                roomsFound: data.roomsFound,
                lastProbeRange: data.lastProbeRange,
                ...(data.optionsSnapshot !== undefined && { optionsSnapshot: data.optionsSnapshot }),
            },
        });
    }
    async complete(id, resultJson) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: client_1.HotelProbeJobStatus.COMPLETED,
                completedAt: new Date(),
                resultJson,
            },
        });
    }
    async skipInsufficient(id, roomsFound, errorMsg) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: client_1.HotelProbeJobStatus.SKIPPED_INSUFFICIENT,
                completedAt: new Date(),
                roomsFound,
                errorMsg,
            },
        });
    }
    async fail(id, errorMsg) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: client_1.HotelProbeJobStatus.FAILED,
                completedAt: new Date(),
                errorMsg,
            },
        });
    }
    async findBySearchRequest(searchRequestId) {
        return prisma.hotelProbeJob.findMany({
            where: { searchRequestId },
            orderBy: { createdAt: 'asc' },
        });
    }
    async findById(id) {
        return prisma.hotelProbeJob.findUnique({ where: { id } });
    }
    /** Delete all probe jobs for a search request (cleanup before re-search). */
    async deleteBySearchRequest(searchRequestId) {
        return prisma.hotelProbeJob.deleteMany({
            where: { searchRequestId },
        });
    }
    /** Re-queue stale RUNNING/PROBING jobs after a worker crash. */
    async requeueStaleJobs(olderThanMs = 120000) {
        const cutoff = new Date(Date.now() - olderThanMs);
        return prisma.hotelProbeJob.updateMany({
            where: {
                status: { in: [client_1.HotelProbeJobStatus.RUNNING, client_1.HotelProbeJobStatus.PROBING] },
                startedAt: { lt: cutoff },
            },
            data: { status: client_1.HotelProbeJobStatus.QUEUED, startedAt: null },
        });
    }
}
exports.HotelProbeJobRepository = HotelProbeJobRepository;
exports.default = new HotelProbeJobRepository();
