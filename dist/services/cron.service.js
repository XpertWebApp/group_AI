"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CronService = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const staticData_service_1 = __importDefault(require("./staticData.service"));
const giataSync_service_1 = __importDefault(require("./giataSync.service"));
const logger_1 = __importDefault(require("../utils/logger"));
class CronService {
    constructor() {
        this.initializeCronJobs();
    }
    initializeCronJobs() {
        // Schedule WBE full sync every Sunday at 00:00 UTC
        node_cron_1.default.schedule('0 0 * * 0', async () => {
            logger_1.default.info('Starting weekly scheduled WBE full sync...');
            try {
                await staticData_service_1.default.fullSync();
                logger_1.default.info('Weekly scheduled WBE full sync completed successfully');
            }
            catch (error) {
                logger_1.default.error({ msg: 'Weekly scheduled WBE full sync failed', error: error.message });
            }
        });
        // GIATA daily incremental sync at 02:00 UTC (changes since yesterday)
        node_cron_1.default.schedule('0 2 * * *', async () => {
            logger_1.default.info('Starting daily GIATA incremental sync...');
            try {
                const result = await giataSync_service_1.default.incrementalSync();
                logger_1.default.info({ result }, 'Daily GIATA incremental sync completed');
            }
            catch (error) {
                logger_1.default.error({ msg: 'Daily GIATA incremental sync failed', error: error.message });
            }
        });
        // GIATA weekly full sync every Sunday at 03:00 UTC (after WBE sync)
        node_cron_1.default.schedule('0 3 * * 0', async () => {
            logger_1.default.info('Starting weekly GIATA full sync...');
            try {
                const result = await giataSync_service_1.default.fullSync();
                logger_1.default.info({ result }, 'Weekly GIATA full sync completed');
            }
            catch (error) {
                logger_1.default.error({ msg: 'Weekly GIATA full sync failed', error: error.message });
            }
        });
        logger_1.default.info('Cron jobs initialized');
    }
}
exports.CronService = CronService;
exports.default = new CronService();
