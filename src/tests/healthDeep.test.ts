/**
 * Tests for /health/deep.
 *
 * On 6 August this endpoint answered 200 OK while a search sat at "0 of 87
 * hotels checked". It was not lying about anything it measured — the database
 * was up and the RabbitMQ channel was open. It simply did not measure the thing
 * that was broken: nothing was consuming the queue.
 *
 * So what is under test here is mostly the new checks, and specifically that
 * each one can fail. A health check that cannot report DEGRADED is decoration.
 */
jest.mock('@prisma/client', () => {
    const mPrisma = { $queryRawUnsafe: jest.fn() };
    return {
        PrismaClient: jest.fn(() => mPrisma),
        Prisma: { DbNull: null, JsonNull: null },
    };
});

jest.mock('../queue/rabbitmq.client', () => ({
    getConnectionStatus: jest.fn(),
    getQueueDepth: jest.fn(),
    closeConnection: jest.fn(),
    HOTEL_PROBE_QUEUE: 'hotel_probe_jobs',
}));

jest.mock('../queue/hotelProbe.worker', () => ({
    isConsuming: jest.fn(),
    getConsumerTag: jest.fn(),
    startHotelProbeWorker: jest.fn(),
}));

// The router pulls in the whole service layer, which is irrelevant here and
// slow to construct. /health/deep is registered before it.
jest.mock('../routes/index', () => ({ __esModule: true, default: require('express').Router() }));

import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { getConnectionStatus, getQueueDepth } from '../queue/rabbitmq.client';
import { isConsuming, getConsumerTag } from '../queue/hotelProbe.worker';
import app from '../app';

const prisma = new (PrismaClient as any)() as any;
const mockRabbit = getConnectionStatus as jest.Mock;
const mockDepth = getQueueDepth as jest.Mock;
const mockConsuming = isConsuming as jest.Mock;
const mockTag = getConsumerTag as jest.Mock;

/** Everything healthy. Individual tests break one thing at a time. */
const healthy = () => {
    mockRabbit.mockReturnValue({
        connected: true,
        reconnecting: false,
        lastSuccessfulConnectAt: Date.now(),
    });
    mockDepth.mockResolvedValue({ messageCount: 0, consumerCount: 1 });
    mockConsuming.mockReturnValue(true);
    mockTag.mockReturnValue('amq.ctag-abc');
    // Both diagnostic counts (queued probe jobs, stuck searches) return zero.
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
        if (sql.includes('SELECT 1')) return Promise.resolve([{ '?column?': 1 }]);
        if (sql.includes('hotel_probe_jobs')) return Promise.resolve([{ queued: 0 }]);
        return Promise.resolve([{ stuck: 0 }]);
    });
};

beforeEach(() => {
    jest.clearAllMocks();
    healthy();
});

describe('/health/deep', () => {
    it('reports OK when everything is working', async () => {
        const res = await request(app).get('/health/deep');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('OK');
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the consumer check — what was missing on 6 August', () => {
        it('goes DEGRADED when nothing is consuming the queue', async () => {
            // The exact incident: channel open, database fine, no consumer.
            // The old endpoint answered 200 to this.
            mockConsuming.mockReturnValue(false);
            mockTag.mockReturnValue(null);

            const res = await request(app).get('/health/deep');

            expect(res.status).toBe(503);
            expect(res.body.checks.probe_consumer.ok).toBe(false);
        });

        it('goes DEGRADED when the broker sees no consumer, whatever we believe', async () => {
            // This process thinks it subscribed; the broker disagrees. The
            // broker is right.
            mockConsuming.mockReturnValue(true);
            mockDepth.mockResolvedValue({ messageCount: 42, consumerCount: 0 });

            const res = await request(app).get('/health/deep');

            expect(res.status).toBe(503);
            expect(res.body.checks.probe_consumer.ok).toBe(false);
        });

        it('reports the queue depth, which names the fault at a glance', async () => {
            mockDepth.mockResolvedValue({ messageCount: 87, consumerCount: 1 });

            const res = await request(app).get('/health/deep');

            expect(res.body.checks.probe_consumer.detail).toContain('queued=87');
            expect(res.body.checks.probe_consumer.detail).toContain('brokerConsumers=1');
        });

        it('still answers when the queue depth cannot be read', async () => {
            // No channel to ask. We report what we know rather than throwing —
            // an endpoint that 500s during an incident is worse than useless.
            mockDepth.mockResolvedValue(null);

            const res = await request(app).get('/health/deep');

            expect(res.status).toBe(200);
            expect(res.body.checks.probe_consumer.detail).toContain('queue depth unavailable');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the queued-jobs check', () => {
        it('goes DEGRADED when probe jobs are piling up unclaimed', async () => {
            prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
                if (sql.includes('SELECT 1')) return Promise.resolve([{ '?column?': 1 }]);
                if (sql.includes('hotel_probe_jobs')) return Promise.resolve([{ queued: 87 }]);
                return Promise.resolve([{ stuck: 0 }]);
            });

            const res = await request(app).get('/health/deep');

            expect(res.status).toBe(503);
            expect(res.body.checks.queued_probe_jobs.detail).toBe(87);
        });

        it('ignores jobs queued in the last two minutes', async () => {
            // A large search legitimately leaves jobs queued for a moment; the
            // worker takes only a couple at a time. Alerting on those would
            // make the endpoint cry wolf on every busy search.
            await request(app).get('/health/deep');

            const sql = prisma.$queryRawUnsafe.mock.calls
                .map((c: any[]) => c[0])
                .find((s: string) => s.includes('hotel_probe_jobs'));
            expect(sql).toMatch(/INTERVAL '2 minutes'/);
        });

        it('counts only QUEUED, not jobs already in flight', async () => {
            await request(app).get('/health/deep');

            const sql = prisma.$queryRawUnsafe.mock.calls
                .map((c: any[]) => c[0])
                .find((s: string) => s.includes('hotel_probe_jobs'));
            expect(sql).toMatch(/status = 'QUEUED'/);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the checks that already existed', () => {
        it('goes DEGRADED when the database is unreachable', async () => {
            prisma.$queryRawUnsafe.mockRejectedValue(new Error('connection refused'));

            const res = await request(app).get('/health/deep');

            expect(res.status).toBe(503);
            expect(res.body.checks.db.ok).toBe(false);
        });

        it('goes DEGRADED when RabbitMQ is disconnected', async () => {
            mockRabbit.mockReturnValue({
                connected: false,
                reconnecting: true,
                lastSuccessfulConnectAt: null,
            });

            const res = await request(app).get('/health/deep');

            expect(res.status).toBe(503);
            expect(res.body.checks.rabbitmq.ok).toBe(false);
        });

        it('goes DEGRADED when searches are stuck in progress', async () => {
            prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
                if (sql.includes('SELECT 1')) return Promise.resolve([{ '?column?': 1 }]);
                if (sql.includes('hotel_probe_jobs')) return Promise.resolve([{ queued: 0 }]);
                return Promise.resolve([{ stuck: 3 }]);
            });

            const res = await request(app).get('/health/deep');

            expect(res.status).toBe(503);
            expect(res.body.checks.stuck_searches.detail).toBe(3);
        });
    });

    it('/health stays up even when dependencies are down', async () => {
        // PM2 restarts the process on a 5xx here, and restarting does not fix
        // a broker outage — the reconnect loop does.
        prisma.$queryRawUnsafe.mockRejectedValue(new Error('db down'));
        mockConsuming.mockReturnValue(false);

        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
    });
});
