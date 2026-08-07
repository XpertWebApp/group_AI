/**
 * Unit tests for the probe job watchdogs.
 *
 * These exist because of a live incident on 6 August: 87 probe jobs sat in
 * QUEUED for two hours while the customer's screen read "0 of 87 hotels
 * checked". Nothing caught it. The orphan sweeper skipped the search because
 * its jobs were not all terminal, and the probe watchdog ignored them because
 * they were not PROBING — a job that no worker ever claimed fell between the
 * two.
 *
 * What is under test is the boundary of each watchdog: which statuses it
 * touches, which it leaves alone, and which timestamp it measures against.
 * Getting any of those wrong either re-opens the blind spot or kills jobs that
 * are legitimately waiting their turn.
 */
jest.mock('@prisma/client', () => {
    const mPrisma = {
        hotelProbeJob: { updateMany: jest.fn() },
    };
    return {
        PrismaClient: jest.fn(() => mPrisma),
        Prisma: { DbNull: null, JsonNull: null },
        HotelProbeJobStatus: {
            QUEUED: 'QUEUED',
            RUNNING: 'RUNNING',
            PROBING: 'PROBING',
            COMPLETED: 'COMPLETED',
            SKIPPED_INSUFFICIENT: 'SKIPPED_INSUFFICIENT',
            FAILED: 'FAILED',
        },
    };
});

import { PrismaClient } from '@prisma/client';
import repo from '../repositories/hotelProbeJob.repository';

const prisma = new (PrismaClient as any)() as any;

/** The `where` clause the repository sent to Prisma. */
const whereClause = () => prisma.hotelProbeJob.updateMany.mock.calls[0][0].where;
const dataClause = () => prisma.hotelProbeJob.updateMany.mock.calls[0][0].data;

beforeEach(() => {
    jest.clearAllMocks();
    prisma.hotelProbeJob.updateMany.mockResolvedValue({ count: 0 });
});

describe('Probe job watchdogs', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('jobs no worker ever claimed', () => {
        it('targets QUEUED jobs — the status nothing watched before', async () => {
            await repo.failStaleQueuedJobs();
            expect(whereClause().status).toBe('QUEUED');
        });

        it('measures from createdAt, not startedAt', async () => {
            // A queued job has never started, so startedAt is null and a filter
            // on it would match nothing — the watchdog would run and quietly
            // find zero every time.
            await repo.failStaleQueuedJobs();
            expect(whereClause()).toHaveProperty('createdAt');
            expect(whereClause()).not.toHaveProperty('startedAt');
        });

        it('only touches jobs older than the threshold', async () => {
            const before = Date.now();
            await repo.failStaleQueuedJobs(300_000);
            const cutoff = whereClause().createdAt.lt.getTime();

            expect(cutoff).toBeLessThanOrEqual(before - 299_000);
            expect(cutoff).toBeGreaterThan(before - 302_000);
        });

        it('waits five minutes by default', async () => {
            // Longer than the PROBING watchdog on purpose. The worker takes
            // only a couple of jobs at a time, so a large search legitimately
            // leaves the rest queued for minutes.
            const before = Date.now();
            await repo.failStaleQueuedJobs();
            const waited = before - whereClause().createdAt.lt.getTime();

            expect(waited).toBeGreaterThanOrEqual(299_000);
            expect(waited).toBeLessThan(302_000);
        });

        it('marks them failed so the search can settle', async () => {
            // The orphan sweeper only resolves a search once every job is
            // terminal. Leaving these QUEUED is what kept the search open.
            await repo.failStaleQueuedJobs();
            expect(dataClause().status).toBe('FAILED');
            expect(dataClause().completedAt).toBeInstanceOf(Date);
        });

        it('records why, and what to check', async () => {
            // Whoever reads this row next needs to know the worker was not
            // consuming — not merely that a job failed.
            await repo.failStaleQueuedJobs();
            expect(dataClause().errorMsg).toMatch(/never claimed by a worker/);
            expect(dataClause().errorMsg).toMatch(/RabbitMQ/);
        });

        it('reports how many it failed', async () => {
            prisma.hotelProbeJob.updateMany.mockResolvedValue({ count: 87 });
            expect(await repo.failStaleQueuedJobs()).toBe(87);
        });

        it('reports zero when nothing is stuck', async () => {
            expect(await repo.failStaleQueuedJobs()).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('jobs a worker claimed but never finished', () => {
        it('targets RUNNING and PROBING, not QUEUED', async () => {
            // The two watchdogs must not overlap: this one measures from
            // startedAt, which a queued job does not have.
            await repo.failStaleProbingJobs();
            expect(whereClause().status.in).toEqual(['RUNNING', 'PROBING']);
            expect(whereClause().status.in).not.toContain('QUEUED');
        });

        it('measures from startedAt', async () => {
            await repo.failStaleProbingJobs();
            expect(whereClause()).toHaveProperty('startedAt');
        });

        it('waits two minutes by default', async () => {
            // Shorter than the queue watchdog: a job that has started should be
            // making progress, so two minutes of silence is already wrong.
            const before = Date.now();
            await repo.failStaleProbingJobs();
            const waited = before - whereClause().startedAt.lt.getTime();

            expect(waited).toBeGreaterThanOrEqual(119_000);
            expect(waited).toBeLessThan(122_000);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('together, the two watchdogs leave no gap', () => {
        it('covers every non-terminal status between them', async () => {
            await repo.failStaleQueuedJobs();
            const queuedTargets = [whereClause().status];

            jest.clearAllMocks();
            prisma.hotelProbeJob.updateMany.mockResolvedValue({ count: 0 });
            await repo.failStaleProbingJobs();
            const probingTargets = whereClause().status.in;

            // QUEUED, RUNNING and PROBING are the three states a job can sit in
            // without ever settling. Any one of them left uncovered is the 6
            // August incident again.
            const covered = new Set([...queuedTargets, ...probingTargets]);
            expect(covered).toEqual(new Set(['QUEUED', 'RUNNING', 'PROBING']));
        });

        it('never touches a job that already settled', async () => {
            // Re-failing a completed job would corrupt a finished search.
            for (const run of [
                () => repo.failStaleQueuedJobs(),
                () => repo.failStaleProbingJobs(),
            ]) {
                jest.clearAllMocks();
                prisma.hotelProbeJob.updateMany.mockResolvedValue({ count: 0 });
                await run();

                const target = whereClause().status;
                const statuses = typeof target === 'string' ? [target] : target.in;
                expect(statuses).not.toContain('COMPLETED');
                expect(statuses).not.toContain('FAILED');
                expect(statuses).not.toContain('SKIPPED_INSUFFICIENT');
            }
        });
    });
});
