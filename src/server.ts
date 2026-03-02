import app from './app';
import config from './config';
import logger from './utils/logger';
import { PrismaClient } from '@prisma/client';
import './services/cron.service'; // Initialize cron jobs

const prisma = new PrismaClient();

const startServer = async () => {
    try {
        await prisma.$connect();
        logger.info('Connected to the database');

        const server = app.listen(config.port, '0.0.0.0', () => {
            logger.info(`Server is running on port ${config.port} in ${config.env} mode`);
            console.log(`Server listening on http://0.0.0.0:${config.port}`);
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
