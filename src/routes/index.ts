import { Router } from 'express';
import authRoutes from './auth.routes';
import webhookRoutes from './webhook.routes';
import adminRoutes from './admin.routes';
import requestsRoutes from './requests.routes';
import proposalsRoutes from './proposals.routes';
import hotelsRoutes from './hotels.routes';
import destinationsRoutes from './destinations.routes';
import nationalitiesRoutes from './nationalities.routes';
import dashboardRoutes from './dashboard.routes';
import settingsRoutes from './settings.routes';
import odooRoutes from './odoo.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/webhook', webhookRoutes);
router.use('/admin', adminRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/settings', settingsRoutes);
router.use('/requests', requestsRoutes);
router.use('/proposals', proposalsRoutes);
router.use('/hotels', hotelsRoutes);
router.use('/destinations', destinationsRoutes);
router.use('/nationalities', nationalitiesRoutes);
router.use('/odoo', odooRoutes);

export default router;
