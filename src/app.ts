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

app.get('/health/deep', async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string | number | null }> = {};
    let overallOk = true;

    // 1. Database — a single trivial SELECT confirms Prisma pool is alive
    //    and Postgres is accepting queries. Fast enough (<10ms) to run on
    //    every health poll without concerns. Catches DB down, credentials
    //    rotated, connection pool exhausted.
    try {
        await healthPrisma.$queryRawUnsafe('SELECT 1');
        checks['db'] = { ok: true };
    } catch (err) {
        overallOk = false;
        checks['db'] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    // 2. RabbitMQ — connected flag from the client module. If the channel
    //    dropped and reconnect hasn't caught up yet, this reports the truth.
    //    lastSuccessfulConnectAt lets ops see when things last worked.
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

    // 3. Stuck-search early-warning: how many BookingRequests have been
    //    stuck in 'in_progress' for > 10 minutes? Non-zero means new
    //    searches are getting swallowed and the orphan sweeper hasn't
    //    caught them yet. Threshold at 10min so brief in-flight probes
    //    (which can run 2-4 min for large destinations) don't false-trip.
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
        // If this query fails we don't fail the whole health check — it's
        // just diagnostic. Log detail so ops can spot query issues.
        checks['stuck_searches'] = {
            ok: false,
            detail: `check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    res.status(overallOk ? 200 : 503).json({
        status: overallOk ? 'OK' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        checks,
    });
});

// Routes
app.use('/api/v1', routes);

// Error Handling
app.use(errorMiddleware);

export default app;
