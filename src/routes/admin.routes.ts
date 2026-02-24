import { Router } from 'express';
import staticDataService from '../services/staticData.service';
import { sendResponse } from '../utils/response';
import { authMiddleware } from '../middlewares/auth.middleware';
import logger from '../utils/logger';

const router = Router();

// Trigger full sync - Admin only
router.post('/sync', authMiddleware, async (req, res, next) => {
    try {
        logger.info('Admin Sync route triggered');

        // Start sync in background
        staticDataService.fullSync().catch(err => {
            logger.error({ msg: 'Background fullSync failed caught in route', error: err.message });
        });

        return sendResponse(res, 202, null, 'Sync started in background');
    } catch (error) {
        next(error);
    }
});

export default router;
