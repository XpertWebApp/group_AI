import { PrismaClient, HotelProbeJobStatus } from '@prisma/client';

const prisma = new PrismaClient();

export class HotelProbeJobRepository {
    async create(data: {
        id: string;
        searchRequestId: string;
        hotelCode: string;
        requestedRooms: number;
        probeLimit: number;
        /** 'main' (default) or 'alternative' — see schema doc. */
        searchKind?: 'main' | 'alternative';
        /** Short label, set when searchKind = 'alternative'. */
        alternativeReason?: string | null;
    }) {
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

    async setRunning(id: string) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: HotelProbeJobStatus.RUNNING,
                startedAt: new Date(),
                attempts: { increment: 1 },
            },
        });
    }

    async updateProbing(id: string, data: {
        roomsFound: number;
        lastProbeRange: string;
        optionsSnapshot?: any;
    }) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: HotelProbeJobStatus.PROBING,
                roomsFound: data.roomsFound,
                lastProbeRange: data.lastProbeRange,
                ...(data.optionsSnapshot !== undefined && { optionsSnapshot: data.optionsSnapshot }),
            },
        });
    }

    async complete(id: string, resultJson: any) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: HotelProbeJobStatus.COMPLETED,
                completedAt: new Date(),
                resultJson,
            },
        });
    }

    async skipInsufficient(id: string, roomsFound: number, errorMsg: string) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: HotelProbeJobStatus.SKIPPED_INSUFFICIENT,
                completedAt: new Date(),
                roomsFound,
                errorMsg,
            },
        });
    }

    async fail(id: string, errorMsg: string) {
        return prisma.hotelProbeJob.update({
            where: { id },
            data: {
                status: HotelProbeJobStatus.FAILED,
                completedAt: new Date(),
                errorMsg,
            },
        });
    }

    async findBySearchRequest(searchRequestId: string) {
        return prisma.hotelProbeJob.findMany({
            where: { searchRequestId },
            orderBy: { createdAt: 'asc' },
        });
    }

    /**
     * Count viable hotels for a given search request. "Viable" means the worker
     * finished probing and the hotel survived all the EC3 filters — i.e.
     * status='COMPLETED'. Both CONFIRMED and LIMITED outcomes are inside this
     * bucket (their distinction lives in the result.capacityStatus JSON field).
     *
     * Used by the pagination orchestrator to decide whether to queue more
     * batches: when this count reaches TARGET_VIABLE_HOTELS we stop iterating.
     */
    async countViable(searchRequestId: string): Promise<number> {
        return prisma.hotelProbeJob.count({
            where: {
                searchRequestId,
                status: 'COMPLETED',
            },
        });
    }

    async findById(id: string) {
        return prisma.hotelProbeJob.findUnique({ where: { id } });
    }

    /** Delete all probe jobs for a search request (cleanup before re-search). */
    async deleteBySearchRequest(searchRequestId: string) {
        return prisma.hotelProbeJob.deleteMany({
            where: { searchRequestId },
        });
    }

    /** Re-queue stale RUNNING/PROBING jobs after a worker crash. */
    async requeueStaleJobs(olderThanMs = 120_000) {
        const cutoff = new Date(Date.now() - olderThanMs);
        return prisma.hotelProbeJob.updateMany({
            where: {
                status: { in: [HotelProbeJobStatus.RUNNING, HotelProbeJobStatus.PROBING] },
                startedAt: { lt: cutoff },
            },
            data: { status: HotelProbeJobStatus.QUEUED, startedAt: null },
        });
    }
}

export default new HotelProbeJobRepository();
