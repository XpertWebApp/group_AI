import app from './app';
import config from './config';
import logger from './utils/logger';
import prisma from './utils/prisma';
import './services/cron.service'; // Initialize cron jobs
import { refreshSupplierLimitsCache } from './config/supplierLimits';

const startServer = async () => {
    try {
        await prisma.$connect();
        logger.info('Connected to the database');

        // Load supplier limits from DB into in-memory cache
        await refreshSupplierLimitsCache();
        logger.info('Supplier limits cache loaded');

        const server = app.listen(config.port, '0.0.0.0', () => {
            logger.info(`Server is running on port ${config.port} in ${config.env} mode`);
        });

        const gracefulShutdown = async () => {
            logger.info('Shutting down server...');
            server.close(async () => {
                logger.info('Server closed');
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
