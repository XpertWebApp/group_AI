import { Router } from 'express';
import authRoutes from './auth.routes';
import webhookRoutes from './webhook.routes';
import adminRoutes from './admin.routes';
import requestsRoutes from './requests.routes';
import proposalsRoutes from './proposals.routes';
import hotelsRoutes from './hotels.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/webhook', webhookRoutes);
router.use('/admin', adminRoutes);
router.use('/requests', requestsRoutes);
router.use('/proposals', proposalsRoutes);
router.use('/hotels', hotelsRoutes);

export default router;
