import { Router } from 'express';
import settingsController from '../controllers/settings.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    UpdateGeneralConfigSchema,
    UpdateEmailConfigSchema,
    UpdateCompanyDetailsSchema,
    UpdatePoliciesSchema,
    UpdateSupplierLimitSchema,
    SupplierLimitsQuerySchema,
} from '../validation/requestSchemas';

const router = Router();

// All settings routes require authentication
router.use(authMiddleware);

// Overview (for the main settings page with 5 cards)
router.get('/', settingsController.overview);

// General Configuration
router.get('/general', settingsController.getGeneralConfig);
router.put('/general', validate(UpdateGeneralConfigSchema), settingsController.updateGeneralConfig);

// Email Configuration
router.get('/email', settingsController.getEmailConfig);
router.put('/email', validate(UpdateEmailConfigSchema), settingsController.updateEmailConfig);

// Company Details
router.get('/company', settingsController.getCompanyDetails);
router.put('/company', validate(UpdateCompanyDetailsSchema), settingsController.updateCompanyDetails);

// Policies
router.get('/policies', settingsController.getPolicies);
router.put('/policies', validate(UpdatePoliciesSchema), settingsController.updatePolicies);

// Supplier Limits
router.get('/supplier-limits', validate(SupplierLimitsQuerySchema, 'query'), settingsController.getSupplierLimits);
router.patch('/supplier-limits/:supplierCode', validate(UpdateSupplierLimitSchema), settingsController.updateSupplierLimit);

export default router;
