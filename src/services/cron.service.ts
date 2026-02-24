import cron from 'node-cron';
import staticDataService from './staticData.service';
import logger from '../utils/logger';

export class CronService {
    constructor() {
        this.initializeCronJobs();
    }

    private initializeCronJobs() {
        // Schedule full sync every Sunday at 00:00
        cron.schedule('0 0 * * 0', async () => {
            logger.info('Starting weekly scheduled full sync...');
            try {
                await staticDataService.fullSync();
                logger.info('Weekly scheduled full sync completed successfully');
            } catch (error: any) {
                logger.error({ msg: 'Weekly scheduled full sync failed', error: error.message });
            }
        });

        logger.info('Cron jobs initialized');
    }
}

export default new CronService();
