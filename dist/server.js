"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./utils/logger"));
const client_1 = require("@prisma/client");
require("./services/cron.service"); // Initialize cron jobs
const supplierLimits_1 = require("./config/supplierLimits");
const hotelProbe_worker_1 = require("./queue/hotelProbe.worker");
const rabbitmq_client_1 = require("./queue/rabbitmq.client");
const prisma = new client_1.PrismaClient();
const startServer = async () => {
    try {
        await prisma.$connect();
        logger_1.default.info('Connected to the database');
        // Load supplier limits from DB into in-memory cache
        await (0, supplierLimits_1.refreshSupplierLimitsCache)();
        logger_1.default.info('Supplier limits cache loaded');
        // Start RabbitMQ hotel probe worker (non-blocking — logs errors and continues)
        (0, hotelProbe_worker_1.startHotelProbeWorker)().catch((err) => {
            logger_1.default.error({ msg: 'Hotel probe worker failed to start', error: err.message });
        });
        const server = app_1.default.listen(config_1.default.port, '0.0.0.0', () => {
            logger_1.default.info(`Server is running on port ${config_1.default.port} in ${config_1.default.env} mode`);
            console.log(`Server listening on http://0.0.0.0:${config_1.default.port}`);
        });
        const gracefulShutdown = async () => {
            logger_1.default.info('Shutting down server...');
            server.close(async () => {
                logger_1.default.info('Server closed');
                await (0, rabbitmq_client_1.closeConnection)();
                await prisma.$disconnect();
                logger_1.default.info('Database disconnected');
                process.exit(0);
            });
        };
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);
    }
    catch (error) {
        logger_1.default.error({ msg: 'Failed to start server', error });
        process.exit(1);
    }
};
startServer();
