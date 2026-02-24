import { Router } from 'express';
import dashboardController from '../controllers/dashboard.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.get('/stats', authMiddleware, dashboardController.stats);
router.get('/recent-offers', authMiddleware, dashboardController.recentOffers);
router.get('/notifications', authMiddleware, dashboardController.notifications);
router.patch('/notifications/:id/read', authMiddleware, dashboardController.markNotificationRead);
router.post('/notifications/read-all', authMiddleware, dashboardController.markAllNotificationsRead);

export default router;
