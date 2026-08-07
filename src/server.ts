import app from './app';
import config from './config';
import logger from './utils/logger';
import { PrismaClient } from '@prisma/client';
import './services/cron.service'; // Initialize cron jobs
import { refreshSupplierLimitsCache } from './config/supplierLimits';
import { warmSenderCache } from './services/emailConfig.helpers';
import { loadDefaultMarkupPercent } from './services/settings.service';
import { startHotelProbeWorker } from './queue/hotelProbe.worker';
import { closeConnection } from './queue/rabbitmq.client';
import hotelSearchService from './services/hotelSearch.service';
import hotelProbeJobRepository from './repositories/hotelProbeJob.repository';
import searchHealthAlertService from './services/searchHealthAlert.service';

const prisma = new PrismaClient();

const startServer = async () => {
    try {
        await prisma.$connect();
        logger.info('Connected to the database');

        // Load supplier limits from DB into in-memory cache
        await refreshSupplierLimitsCache();
        logger.info('Supplier limits cache loaded');

        // Warm the email-sender identity cache so the first outbound mail
        // doesn't pay a DB hit. Non-blocking — falls back to env defaults
        // if the warmup fails.
        await warmSenderCache();
        logger.info('Email sender cache warmed');

        // Warm the default-markup cache so calculate-price calls and other
        // sync read paths (calculateSellPrice, recalcTotals) return the
        // current Settings value from cold-start onwards.
        const initialMarkup = await loadDefaultMarkupPercent();
        logger.info({ defaultMarkupPercent: initialMarkup }, 'Default markup cache warmed');

        // Start RabbitMQ hotel probe worker (non-blocking — logs errors and continues)
        startHotelProbeWorker().catch((err) => {
            logger.error({ msg: 'Hotel probe worker failed to start', error: err.message });
        });

        // Orphan-search sweeper — recovers from in-memory watcher death
        // (server restart, silent crash) that leaves booking_requests stuck
        // in search_phase='in_progress' forever. Two passes:
        //   • Boot pass with a short 2-min threshold to clean up anything that
        //     was already stale at restart time. Runs once after the server
        //     starts listening.
        //   • Periodic pass every 90 seconds with a 3-min threshold to catch
        //     in-flight watcher crashes that happen between restarts. 90s
        //     polling means worst-case stuck-time is ~3min + 90s before the
        //     FE sees a terminal phase.
        // Both are non-blocking and best-effort; errors logged but don't kill
        // the server.
        setImmediate(() => {
            hotelSearchService.resumeOrphanedSearches(2).catch((err) => {
                logger.error({ msg: 'Orphan-search sweeper (boot) failed', error: err?.message });
            });
        });
        setInterval(() => {
            hotelSearchService.resumeOrphanedSearches(3).catch((err) => {
                logger.error({ msg: 'Orphan-search sweeper (periodic) failed', error: err?.message });
            });
        }, 90_000);

        // Probe-job watchdog — fails individual probes stuck in PROBING /
        // RUNNING for >2 minutes. Different from the search sweeper above:
        // that one rescues entire searches whose watcher died; this one
        // unblocks a search whose 399/400 probes finished but ONE specific
        // hotel's WBE call hung. Without this, the watcher polls forever
        // waiting for the stuck probe to reach a terminal state. Fast
        // cadence (30s) because the search-level recovery depends on it.
        const PROBE_WATCHDOG_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
        setImmediate(() => {
            hotelProbeJobRepository
                .failStaleProbingJobs(PROBE_WATCHDOG_THRESHOLD_MS)
                .then((count) => {
                    if (count > 0) {
                        logger.warn({ count }, 'Probe watchdog (boot): failed stale PROBING jobs');
                    }
                })
                .catch((err) => {
                    logger.error({ msg: 'Probe watchdog (boot) failed', error: err?.message });
                });
        });
        setInterval(() => {
            hotelProbeJobRepository
                .failStaleProbingJobs(PROBE_WATCHDOG_THRESHOLD_MS)
                .then((count) => {
                    if (count > 0) {
                        logger.warn({ count }, 'Probe watchdog: failed stale PROBING jobs');
                    }
                })
                .catch((err) => {
                    logger.error({ msg: 'Probe watchdog (periodic) failed', error: err?.message });
                });
        }, 30_000);

        // Jobs that no worker ever claimed. Separate from the PROBING watchdog
        // above, which only sees jobs already in flight — a job stuck in QUEUED
        // was invisible to every sweeper, which is how 87 of them sat for two
        // hours on 6 August while the search reported "0 of 87 checked".
        //
        // Logged at error, not warn: a queued job past this threshold means the
        // worker is not consuming, and that affects every search, not one.
        const QUEUE_WATCHDOG_THRESHOLD_MS = 5 * 60 * 1000;
        setInterval(() => {
            hotelProbeJobRepository
                .failStaleQueuedJobs(QUEUE_WATCHDOG_THRESHOLD_MS)
                .then((count) => {
                    if (count > 0) {
                        logger.error(
                            { count, thresholdMinutes: QUEUE_WATCHDOG_THRESHOLD_MS / 60_000 },
                            'Queue watchdog: jobs were never claimed by a worker — is it subscribed to RabbitMQ?',
                        );
                    }
                })
                .catch((err) => {
                    logger.error({ msg: 'Queue watchdog failed', error: err?.message });
                });
        }, 60_000);

        // Tell staff a search has stalled before a customer does. The watchdogs
        // above settle the jobs; this is the part that was missing on 6 August,
        // when the condition sat visible in the database for two hours and the
        // first report came from the client.
        setInterval(() => {
            searchHealthAlertService.checkAndAlert().catch((err) => {
                logger.error({ msg: 'Stalled-search alerting failed', error: err?.message });
            });
        }, 60_000);

        const server = app.listen(config.port, '0.0.0.0', () => {
            // Port and pid as structured fields, not just interpolated text.
            // On 6 August this line existed only as console.log, so `pm2 logs`
            // showed it but the JSON logs did not — half an hour went into
            // curling port 4000 while the server was listening on 3005.
            logger.info(
                {
                    port: config.port,
                    env: config.env,
                    pid: process.pid,
                    healthUrl: `http://127.0.0.1:${config.port}/health/deep`,
                },
                'Server listening',
            );
            console.log(`Server listening on http://0.0.0.0:${config.port}`);
        });

        const gracefulShutdown = async () => {
            logger.info('Shutting down server...');
            server.close(async () => {
                logger.info('Server closed');
                await closeConnection();
                await prisma.$disconnect();
                logger.info('Database disconnected');
                process.exit(0);
            });
        };

        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);
    } catch (error) {
        logger.error({ msg: 'Failed to start server', error });
        process.exit(1);
    }
};

startServer();
