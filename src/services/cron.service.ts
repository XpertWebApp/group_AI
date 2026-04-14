import cron from 'node-cron';
import staticDataService from './staticData.service';
import giataSyncService from './giataSync.service';
import logger from '../utils/logger';

export class CronService {
    constructor() {
        this.initializeCronJobs();
    }

    private initializeCronJobs() {
        // Schedule WBE full sync every Sunday at 00:00 UTC
        cron.schedule('0 0 * * 0', async () => {
            logger.info('Starting weekly scheduled WBE full sync...');
            try {
                await staticDataService.fullSync();
                logger.info('Weekly scheduled WBE full sync completed successfully');
            } catch (error: any) {
                logger.error({ msg: 'Weekly scheduled WBE full sync failed', error: error.message });
            }
        });

        // GIATA daily incremental sync at 02:00 UTC (changes since yesterday)
        cron.schedule('0 2 * * *', async () => {
            logger.info('Starting daily GIATA incremental sync...');
            try {
                const result = await giataSyncService.incrementalSync();
                logger.info({ result }, 'Daily GIATA incremental sync completed');
            } catch (error: any) {
                logger.error({ msg: 'Daily GIATA incremental sync failed', error: error.message });
            }
        });

        // GIATA weekly full sync every Sunday at 03:00 UTC (after WBE sync)
        cron.schedule('0 3 * * 0', async () => {
            logger.info('Starting weekly GIATA full sync...');
            try {
                const result = await giataSyncService.fullSync();
                logger.info({ result }, 'Weekly GIATA full sync completed');
            } catch (error: any) {
                logger.error({ msg: 'Weekly GIATA full sync failed', error: error.message });
            }
        });

        logger.info('Cron jobs initialized');
    }
}

export default new CronService();
