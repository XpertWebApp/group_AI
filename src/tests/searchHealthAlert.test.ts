/**
 * Unit tests for stalled-search alerting.
 *
 * Written after a live incident on 6 August where a search sat at "0 of 87
 * hotels checked" for two hours. The condition was in the database and on
 * /health/deep the entire time; nobody was watching, so the first report came
 * from the client.
 *
 * Two behaviours matter here. It has to notice — a stalled search that raises
 * nothing is the incident again. And it must not repeat itself: the check runs
 * every minute, and an alert that arrives sixty times an hour is one people
 * learn to ignore.
 */
jest.mock('@prisma/client', () => {
    const mPrisma = { $queryRawUnsafe: jest.fn() };
    return {
        PrismaClient: jest.fn(() => mPrisma),
        Prisma: { DbNull: null, JsonNull: null },
    };
});

jest.mock('../services/notification.service', () => ({
    __esModule: true,
    default: { notify: jest.fn() },
    resolveStaffNotificationEmail: jest.fn(() => 'ops@example.com'),
}));

import { PrismaClient } from '@prisma/client';
import notificationService from '../services/notification.service';
import service, { STALL_THRESHOLD_MS } from '../services/searchHealthAlert.service';

const prisma = new (PrismaClient as any)() as any;
const notify = (notificationService as jest.Mocked<any>).notify;

/** A stalled row in the shape the query returns. */
const stalledRow = (over: Record<string, unknown> = {}) => ({
    id: 'request-1',
    reference_number: 542,
    destination_name: 'Bursa',
    updated_at: new Date(Date.now() - 30 * 60_000),
    jobs_total: BigInt(87),
    jobs_done: BigInt(0),
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    notify.mockResolvedValue(undefined);
});

describe('Stalled-search alerting', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('noticing a stall', () => {
        it('reports nothing when every search is moving', async () => {
            expect(await service.findStalledSearches()).toEqual([]);
        });

        it('reports a search that has stopped progressing', async () => {
            prisma.$queryRawUnsafe.mockResolvedValue([stalledRow()]);

            const [stalled] = await service.findStalledSearches();
            expect(stalled?.referenceNumber).toBe(542);
        });

        it('carries how long it has been stuck', async () => {
            prisma.$queryRawUnsafe.mockResolvedValue([
                stalledRow({ updated_at: new Date(Date.now() - 45 * 60_000) }),
            ]);

            const [stalled] = await service.findStalledSearches();
            expect(stalled?.stalledForMinutes).toBeGreaterThanOrEqual(44);
            expect(stalled?.stalledForMinutes).toBeLessThanOrEqual(46);
        });

        it('carries the progress, which is what identifies the failure', async () => {
            // 0 of 87 means the jobs never ran; 87 of 87 means they finished
            // and the search failed to settle. Different causes, and the
            // number is what tells them apart.
            prisma.$queryRawUnsafe.mockResolvedValue([
                stalledRow({ jobs_total: BigInt(87), jobs_done: BigInt(0) }),
            ]);

            const [stalled] = await service.findStalledSearches();
            expect(stalled?.jobsTotal).toBe(87);
            expect(stalled?.jobsDone).toBe(0);
        });

        it('only looks at searches older than the threshold', async () => {
            await service.findStalledSearches();

            const cutoff: Date = prisma.$queryRawUnsafe.mock.calls[0][1];
            const age = Date.now() - cutoff.getTime();
            expect(age).toBeGreaterThanOrEqual(STALL_THRESHOLD_MS - 2_000);
            expect(age).toBeLessThan(STALL_THRESHOLD_MS + 2_000);
        });

        it('only looks at searches still in progress', async () => {
            // A settled search is not stalled however old it is.
            await service.findStalledSearches();
            expect(prisma.$queryRawUnsafe.mock.calls[0][0]).toMatch(/search_phase = 'in_progress'/);
        });

        it('counts a job as done only once it has settled', async () => {
            await service.findStalledSearches();
            const query: string = prisma.$queryRawUnsafe.mock.calls[0][0];

            expect(query).toContain('COMPLETED');
            expect(query).toContain('FAILED');
            expect(query).toContain('SKIPPED_INSUFFICIENT');
            // QUEUED must not count as progress — that was the whole incident.
            expect(query).not.toMatch(/FILTER[\s\S]*'QUEUED'/);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('raising the alert', () => {
        // Each test uses a distinct id: the throttle is module-level and
        // deliberately survives between calls, so a shared id would let the
        // first test suppress the rest.
        let seq = 0;
        beforeEach(() => {
            prisma.$queryRawUnsafe.mockResolvedValue([
                stalledRow({ id: `alert-test-${++seq}` }),
            ]);
        });

        it('notifies staff', async () => {
            expect(await service.checkAndAlert()).toBe(1);
            expect(notify).toHaveBeenCalled();
        });

        it('names the request, so it can be found', async () => {
            prisma.$queryRawUnsafe.mockResolvedValue([stalledRow({ id: 'named-request' })]);

            await service.checkAndAlert();
            const arg = notify.mock.calls[0][0];
            expect(arg.title).toContain('542');
            // entityId is what links the alert back to the request in the UI.
            expect(arg.entityId).toBe('named-request');
        });

        it('says what the customer is seeing', async () => {
            await service.checkAndAlert();
            expect(notify.mock.calls[0][0].message).toMatch(/0 of 87 hotels checked/);
        });

        it('points at where to look', async () => {
            // Whoever picks this up at 2am needs the next step, not just the
            // news that something is wrong.
            await service.checkAndAlert();
            expect(notify.mock.calls[0][0].message).toMatch(/health\/deep/);
        });

        it('sends no alert when nothing is stalled', async () => {
            prisma.$queryRawUnsafe.mockResolvedValue([]);

            expect(await service.checkAndAlert()).toBe(0);
            expect(notify).not.toHaveBeenCalled();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('not becoming noise', () => {
        it('alerts once, not on every check', async () => {
            // The check runs every minute. Without throttling one stalled
            // search would send sixty alerts an hour.
            prisma.$queryRawUnsafe.mockResolvedValue([stalledRow({ id: 'throttle-test' })]);

            expect(await service.checkAndAlert()).toBe(1);
            expect(await service.checkAndAlert()).toBe(0);
            expect(await service.checkAndAlert()).toBe(0);
            expect(notify).toHaveBeenCalledTimes(1);
        });

        it('alerts separately for separate searches', async () => {
            prisma.$queryRawUnsafe.mockResolvedValue([
                stalledRow({ id: 'req-a', reference_number: 601 }),
                stalledRow({ id: 'req-b', reference_number: 602 }),
            ]);

            expect(await service.checkAndAlert()).toBe(2);
        });

        it('alerts again after a search stalls a second time', async () => {
            // The throttle is cleared once nothing is stalled, so a fresh stall
            // on the same request is not silently swallowed.
            prisma.$queryRawUnsafe.mockResolvedValue([stalledRow({ id: 'recurring' })]);
            await service.checkAndAlert();

            prisma.$queryRawUnsafe.mockResolvedValue([]);
            await service.checkAndAlert();

            prisma.$queryRawUnsafe.mockResolvedValue([stalledRow({ id: 'recurring' })]);
            expect(await service.checkAndAlert()).toBe(1);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('failing safely', () => {
        it('does not throw when the query fails', async () => {
            // A failing check must not take the server down — but it does mean
            // we are blind, which the service logs as an error.
            prisma.$queryRawUnsafe.mockRejectedValue(new Error('database unreachable'));

            await expect(service.checkAndAlert()).resolves.toBe(0);
        });

        it('does not throw when the notification fails', async () => {
            prisma.$queryRawUnsafe.mockResolvedValue([stalledRow({ id: 'notify-fails' })]);
            notify.mockRejectedValue(new Error('SMTP down'));

            await expect(service.checkAndAlert()).resolves.toBe(0);
        });
    });
});
