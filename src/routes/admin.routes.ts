import { Router } from 'express';
import staticDataService from '../services/staticData.service';
import { sendResponse } from '../utils/response';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

// Trigger full sync - Admin only
router.post('/sync', authMiddleware, async (req, res, next) => {
    try {
        // Start sync in background
        staticDataService.fullSync();
        return sendResponse(res, 202, null, 'Sync started in background');
    } catch (error) {
        next(error);
    }
});

export default router;
