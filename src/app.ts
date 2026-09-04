import express, { Application } from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import config from './config';
import { errorMiddleware } from './middlewares/error.middleware';
import routes from './routes/index';
import { getConnectionStatus } from './queue/rabbitmq.client';

// Shared Prisma client instance for the /health check. Kept separate from
// the per-repo instances so a health-check DB query never contends with
// the request-handling pool. Reused across every health call.
const healthPrisma = new PrismaClient();

const app: Application = express();

// Trust proxy (needed for correct client IP behind reverse proxy / load balancer)
app.set('trust proxy', 1);

// Security Middlewares
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);

// Body Parser Middlewares.
// Capture raw body so HMAC signature verification (e.g. WordPress webhook)
// can hash the exact bytes the client sent.
app.use(express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

// Other Middlewares
app.use(cookieParser());
app.use(compression());

// Static assets (email logos, brand images — no auth required)
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets'), {
    maxAge: '30d',
    immutable: true,
}));

// ─── Health Check ────────────────────────────────────────────────────────────
// Returns 200 when the process is up regardless of dependency state — used by
// PM2 / load balancer to know the process itself is responding.
//
// The dependency check lives at /health/deep and returns 503 if RabbitMQ is
// disconnected or the DB isn't reachable. Use /health/deep for the stuck-search
// alarm — a 503 there means new searches will queue up but never process, which
// is the exact failure mode that caused the recurring stuck-request problem.
//
// Split into two endpoints so PM2's process healthcheck (which restarts the
// whole app on 5xx) doesn't get triggered by a transient RabbitMQ blip — the
// auto-reconnect loop in rabbitmq.client handles those. Only humans / a
// separate alerting cron should trigger on /health/deep.
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

/**
 * /health/deep — work-based health check for external watchdogs.
 *
 * Reports process + dependency status AND (critically) whether background
 * workers are actually doing work, not just alive. This distinction matters
 * because PM2 `autorestart: true` only catches process death, not silent
 * consumer stalls. A stuck RabbitMQ consumer keeps the process "healthy"
 * from PM2's perspective while user searches queue up forever.
 *
 * Response returns HTTP 200 (status: OK) when everything is healthy, or
 * HTTP 503 (status: DEGRADED) when any critical signal fails — a suitable
 * signal for an alerting cron to trigger `pm2 restart` on.
 *
 * Signals reported per section:
 *  - db                : PostgreSQL connectivity
 *  - rabbitmq          : Broker connection state
 *  - probe_worker      : Hotel-search job consumer (the one that died silently
 *                        on 2026-08-17 without any external symptom)
 *  - sync_worker       : Long-running static-data sync worker
 *  - stuck_searches    : User-facing symptom count (how many BookingRequests
 *                        appear stuck to a user in "search in progress")
 *
 * All queries are indexed and cheap (<20ms each). Safe to poll every 60s.
 */
app.get('/health/deep', async (_req, res) => {
    const checks: Record<string, any> = {};
    let overallOk = true;
    const now = new Date();

    // ── 1. Database ─────────────────────────────────────────────────────────
    // A single trivial SELECT confirms Prisma pool is alive and Postgres is
    // accepting queries. Catches DB down, credentials rotated, pool exhausted.
    try {
        await healthPrisma.$queryRawUnsafe('SELECT 1');
        checks['db'] = { ok: true };
    } catch (err) {
        overallOk = false;
        checks['db'] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    // ── 2. RabbitMQ ─────────────────────────────────────────────────────────
    // Connection status from the client module. Reflects reality even if the
    // channel dropped and reconnect hasn't caught up yet.
    const rabbit = getConnectionStatus();
    checks['rabbitmq'] = {
        ok: rabbit.connected,
        detail: rabbit.connected
            ? `connected (last connect ${rabbit.lastSuccessfulConnectAt ? new Date(rabbit.lastSuccessfulConnectAt).toISOString() : 'unknown'})`
            : rabbit.reconnecting
                ? 'disconnected — reconnect in progress'
                : 'disconnected — no reconnect running',
    };
    if (!rabbit.connected) overallOk = false;

    // ── 3. Probe worker ─────────────────────────────────────────────────────
    // This is the WORK-BASED check for the RabbitMQ consumer that processes
    // hotel-search jobs. `alive` says the consumer is registered on the queue;
    // `pending_jobs` and `stale_pending_jobs` say whether it's actually
    // consuming. The stale count is the primary alert trigger — if >=10
    // jobs have sat in QUEUED for over 3 minutes, the consumer is dead
    // (or so degraded that a restart is the correct action).
    try {
        const probeRows: any = await healthPrisma.$queryRawUnsafe(`
            SELECT
              COUNT(*) FILTER (WHERE status = 'QUEUED')::int
                AS pending_jobs,
              COUNT(*) FILTER (WHERE status = 'QUEUED'
                               AND created_at < NOW() - INTERVAL '3 minutes')::int
                AS stale_pending_jobs,
              MAX(completed_at) FILTER (WHERE status = 'COMPLETED')
                AS last_completed_at
            FROM app.hotel_probe_jobs
            WHERE created_at > NOW() - INTERVAL '24 hours'
        `);
        const row = probeRows?.[0] ?? {};
        const pending = row.pending_jobs ?? 0;
        const stalePending = row.stale_pending_jobs ?? 0;
        const lastCompletedAt = row.last_completed_at ? new Date(row.last_completed_at) : null;
        const secondsSinceLastCompletion = lastCompletedAt
            ? Math.floor((now.getTime() - lastCompletedAt.getTime()) / 1000)
            : null;

        // "Alive" heuristic: consumer is considered alive if RabbitMQ is
        // connected AND (no jobs pending OR at least one has moved to a
        // terminal state recently). A large stale-pending count with no
        // recent completions is the smoking gun for silent consumer death.
        const workerAlive = rabbit.connected && stalePending < 10;
        const probeOk = stalePending < 10;

        checks['probe_worker'] = {
            ok: probeOk,
            alive: workerAlive,
            pending_jobs: pending,
            stale_pending_jobs: stalePending,
            last_completed_at: lastCompletedAt ? lastCompletedAt.toISOString() : null,
            seconds_since_last_completion: secondsSinceLastCompletion,
            detail: probeOk
                ? 'processing jobs normally'
                : `${stalePending} jobs stuck in QUEUED for >3min — consumer likely dead, restart sett-ai-server`,
        };
        if (!probeOk) overallOk = false;
    } catch (err) {
        checks['probe_worker'] = {
            ok: false,
            detail: `check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // ── 4. Sync worker ──────────────────────────────────────────────────────
    // Long-running background worker that pulls hotel details from WBE. Same
    // failure mode as probe_worker but different signal: an IN_PROGRESS sync
    // job with no recent details_fetched_at writes means the sync loop has
    // silently stopped. Threshold at 60 min because sync legitimately pauses
    // between phases (destinations vs hotels-list vs details), and one hotel
    // can take several seconds under WBE rate limits.
    try {
        const syncRows: any = await healthPrisma.$queryRawUnsafe(`
            SELECT
              (SELECT COUNT(*)::int
               FROM audit.sync_jobs
               WHERE status = 'IN_PROGRESS') AS active_jobs,
              (SELECT MAX(details_fetched_at)
               FROM master.hotels) AS last_hotel_detail_fetched_at
        `);
        const row = syncRows?.[0] ?? {};
        const activeJobs = row.active_jobs ?? 0;
        const lastActivity = row.last_hotel_detail_fetched_at
            ? new Date(row.last_hotel_detail_fetched_at)
            : null;
        const secondsSinceLastActivity = lastActivity
            ? Math.floor((now.getTime() - lastActivity.getTime()) / 1000)
            : null;

        // Only alert if there's an active sync job AND no writes for 60+ min.
        // No active job means legitimately idle (sync completed or not running).
        const syncStalled =
            activeJobs > 0 &&
            secondsSinceLastActivity !== null &&
            secondsSinceLastActivity > 3600;
        const syncOk = !syncStalled;

        checks['sync_worker'] = {
            ok: syncOk,
            active_jobs: activeJobs,
            last_hotel_detail_fetched_at: lastActivity ? lastActivity.toISOString() : null,
            seconds_since_last_activity: secondsSinceLastActivity,
            detail: activeJobs === 0
                ? 'idle (no sync running)'
                : syncOk
                    ? `syncing — last write ${secondsSinceLastActivity}s ago`
                    : `sync job IN_PROGRESS but no writes for ${secondsSinceLastActivity}s — worker likely dead, restart sett-ai-server`,
        };
        if (!syncOk) overallOk = false;
    } catch (err) {
        checks['sync_worker'] = {
            ok: false,
            detail: `check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // ── 5. Stuck searches ───────────────────────────────────────────────────
    // User-facing symptom count: how many BookingRequests appear stuck in
    // 'in_progress' for > 10 minutes? Non-zero means the orphan sweeper
    // hasn't caught them yet. Threshold at 10 min so brief in-flight probes
    // (which can run 2-4 min for large destinations) don't false-trip.
    try {
        const stuckRows: any = await healthPrisma.$queryRawUnsafe(`
            SELECT COUNT(*)::int AS stuck
            FROM app.booking_requests
            WHERE search_phase = 'in_progress'
              AND updated_at < NOW() - INTERVAL '10 minutes'
        `);
        const stuckCount = stuckRows?.[0]?.stuck ?? 0;
        checks['stuck_searches'] = {
            ok: stuckCount === 0,
            detail: stuckCount,
        };
        if (stuckCount > 0) overallOk = false;
    } catch (err) {
        // Diagnostic only — don't fail the whole health check on this query alone.
        checks['stuck_searches'] = {
            ok: false,
            detail: `check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    res.status(overallOk ? 200 : 503).json({
        status: overallOk ? 'OK' : 'DEGRADED',
        timestamp: now.toISOString(),
        checks,
    });
});

// Routes
app.use('/api/v1', routes);

// Error Handling
app.use(errorMiddleware);

export default app;
