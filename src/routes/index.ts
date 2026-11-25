import { Router } from 'express';
import authRoutes from './auth.routes';
import webhookRoutes from './webhook.routes';
import optionSelectionRoutes, { staffSelectionRouter } from './optionSelection.routes';
import adminRoutes from './admin.routes';
import requestsRoutes from './requests.routes';
import proposalsRoutes from './proposals.routes';
import hotelsRoutes from './hotels.routes';
import destinationsRoutes from './destinations.routes';
import nationalitiesRoutes from './nationalities.routes';
import dashboardRoutes from './dashboard.routes';
import settingsRoutes from './settings.routes';
import odooRoutes from './odoo.routes';
import bookingsRoutes from './bookings.routes';
import bookingGroupsRoutes from './bookingGroups.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/webhook', webhookRoutes);
// Reached from the customer's selection link, without a login — the token in
// the URL is the credential.
router.use('/select', optionSelectionRoutes);
router.use('/selections', staffSelectionRouter);
router.use('/admin', adminRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/settings', settingsRoutes);
router.use('/requests', requestsRoutes);
router.use('/proposals', proposalsRoutes);
router.use('/hotels', hotelsRoutes);
router.use('/destinations', destinationsRoutes);
router.use('/nationalities', nationalitiesRoutes);
router.use('/odoo', odooRoutes);
router.use('/bookings', bookingsRoutes);
router.use('/booking-groups', bookingGroupsRoutes);

export default router;
