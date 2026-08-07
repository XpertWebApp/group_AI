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

    /**
     * Count ALL probe jobs (main + alternative, every status) for a request.
     * Used by `canSearchMore` to compare actual probed hotels against the
     * destination's total candidate count — catches the case where the
     * persisted pagination cursor lags behind reality (multiple Search
     * More clicks racing with the mini-watcher's cursor write).
     */
    async countBySearchRequest(searchRequestId: string): Promise<number> {
        return prisma.hotelProbeJob.count({
            where: { searchRequestId },
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

    /**
     * Fail any probe stuck in PROBING / RUNNING for longer than the cutoff.
     *
     * Different from `requeueStaleJobs` — we don't try to re-queue them
     * because that would loop forever on hotels whose WBE call genuinely
     * hangs (e.g. a specific hotel code that times out on the supplier
     * side). Marking the probe FAILED lets the post-probe watcher reach
     * an all-terminal state on its next 5s poll and settle the search.
     *
     * Returns the count of probes failed so the caller can log it.
     */
    async failStaleProbingJobs(olderThanMs = 120_000) {
        const cutoff = new Date(Date.now() - olderThanMs);
        const result = await prisma.hotelProbeJob.updateMany({
            where: {
                status: { in: [HotelProbeJobStatus.RUNNING, HotelProbeJobStatus.PROBING] },
                startedAt: { lt: cutoff },
            },
            data: {
                status: HotelProbeJobStatus.FAILED,
                completedAt: new Date(),
                errorMsg: `Probe watchdog: stuck >${Math.round(olderThanMs / 1000)}s, auto-failed so the search can settle`,
            },
        });
        return result.count;
    }

    /**
     * Fail jobs that were never picked up by a worker.
     *
     * The gap that caused the 6 August incident. `failStaleProbingJobs` only
     * looks at RUNNING and PROBING — jobs a worker has already claimed. A job
     * sitting in QUEUED means no worker ever claimed it, and nothing watched
     * for that: 87 of them sat untouched for two hours while the orphan sweeper
     * skipped the search (its jobs were not all terminal) and the probe
     * watchdog ignored them (they were not PROBING).
     *
     * Uses a longer default than the PROBING watchdog. A queued job is waiting
     * its turn, which is normal under load — the worker takes only
     * WORKER_JOB_CONCURRENCY at a time, so a large search legitimately leaves
     * jobs queued for minutes. Five minutes is past any legitimate wait.
     *
     * Failing rather than re-publishing is deliberate, for the same reason as
     * the sibling method: if the consumer is genuinely absent, re-publishing
     * loops forever. Failing lets the search settle and surfaces the problem.
     */
    async failStaleQueuedJobs(olderThanMs = 300_000) {
        const cutoff = new Date(Date.now() - olderThanMs);
        const result = await prisma.hotelProbeJob.updateMany({
            where: {
                status: HotelProbeJobStatus.QUEUED,
                // createdAt, not startedAt: a queued job has never started, so
                // startedAt is null and would match nothing.
                createdAt: { lt: cutoff },
            },
            data: {
                status: HotelProbeJobStatus.FAILED,
                completedAt: new Date(),
                errorMsg:
                    `Queue watchdog: never claimed by a worker within ` +
                    `${Math.round(olderThanMs / 1000)}s — check the worker is subscribed to RabbitMQ`,
            },
        });
        return result.count;
    }
}

export default new HotelProbeJobRepository();
