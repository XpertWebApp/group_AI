import { Router } from 'express';
import settingsController from '../controllers/settings.controller';
import staffController from '../controllers/staff.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { adminGuard } from '../middlewares/adminGuard.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    UpdateGeneralConfigSchema,
    UpdateEmailConfigSchema,
    UpdateCompanyDetailsSchema,
    UpdatePoliciesSchema,
    UpdateSupplierLimitSchema,
    SupplierLimitsQuerySchema,
    ListStaffQuerySchema,
    AddStaffSchema,
    ToggleStaffStatusSchema,
} from '../validation/requestSchemas';

const router = Router();

// All settings routes require authentication + admin role
router.use(authMiddleware);
router.use(adminGuard);

// Overview (for the main settings page with 5 cards)
router.get('/', settingsController.overview);

// General Configuration
router.get('/general', settingsController.getGeneralConfig);
router.put('/general', validate(UpdateGeneralConfigSchema), settingsController.updateGeneralConfig);

// Email Configuration (Google OAuth)
router.get('/email', settingsController.getEmailConfig);
router.put('/email', validate(UpdateEmailConfigSchema), settingsController.updateEmailConfig);
router.post('/email/disconnect/:userId', settingsController.disconnectUserGoogle);

// Company Details
router.get('/company', settingsController.getCompanyDetails);
router.put('/company', validate(UpdateCompanyDetailsSchema), settingsController.updateCompanyDetails);

// Policies
router.get('/policies', settingsController.getPolicies);
router.put('/policies', validate(UpdatePoliciesSchema), settingsController.updatePolicies);

// Supplier Limits
router.get('/supplier-limits', validate(SupplierLimitsQuerySchema, 'query'), settingsController.getSupplierLimits);
router.patch('/supplier-limits/:supplierCode', validate(UpdateSupplierLimitSchema), settingsController.updateSupplierLimit);

// Staff Management
router.get('/staff', validate(ListStaffQuerySchema, 'query'), staffController.list);
router.post('/staff', validate(AddStaffSchema), staffController.add);
router.patch('/staff/:id/status', validate(ToggleStaffStatusSchema), staffController.toggleStatus);
router.post('/staff/:id/reset-password', staffController.resetPassword);
router.delete('/staff/:id', staffController.delete);

export default router;
