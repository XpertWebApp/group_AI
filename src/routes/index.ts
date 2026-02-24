import { Router } from 'express';
import authRoutes from './auth.routes';
import webhookRoutes from './webhook.routes';
import adminRoutes from './admin.routes';
import hotelsRoutes from './hotels.routes';
import destinationsRoutes from './destinations.routes';
import requestsRoutes from './requests.routes';
import proposalsRoutes from './proposals.routes';
import dashboardRoutes from './dashboard.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/webhook', webhookRoutes);
router.use('/admin', adminRoutes);
router.use('/hotels', hotelsRoutes);
router.use('/destinations', destinationsRoutes);
router.use('/requests', requestsRoutes);
router.use('/proposals', proposalsRoutes);
router.use('/dashboard', dashboardRoutes);

export default router;
