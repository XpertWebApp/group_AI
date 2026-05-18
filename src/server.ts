import app from './app';
import config from './config';
import logger from './utils/logger';
import { PrismaClient } from '@prisma/client';
import './services/cron.service'; // Initialize cron jobs
import { refreshSupplierLimitsCache } from './config/supplierLimits';
import { startHotelProbeWorker } from './queue/hotelProbe.worker';
import { closeConnection } from './queue/rabbitmq.client';
import hotelSearchService from './services/hotelSearch.service';

const prisma = new PrismaClient();

const startServer = async () => {
    try {
        await prisma.$connect();
        logger.info('Connected to the database');

        // Load supplier limits from DB into in-memory cache
        await refreshSupplierLimitsCache();
        logger.info('Supplier limits cache loaded');

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

        const server = app.listen(config.port, '0.0.0.0', () => {
            logger.info(`Server is running on port ${config.port} in ${config.env} mode`);
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
