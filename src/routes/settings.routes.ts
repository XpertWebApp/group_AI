import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import settingsController from '../controllers/settings.controller';
import staffController from '../controllers/staff.controller';
import giataSyncController from '../controllers/giataSync.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { adminGuard } from '../middlewares/adminGuard.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    UpdateGeneralConfigSchema,
    UpdateEmailConfigSchema,
    SendTestEmailSchema,
    UpdateCompanyDetailsSchema,
    UpdatePoliciesSchema,
    UpdateSupplierLimitSchema,
    SupplierLimitsQuerySchema,
    ListStaffQuerySchema,
    AddStaffSchema,
    ToggleStaffStatusSchema,
} from '../validation/requestSchemas';

// Test-send rate limit per `email-config-settings-handover.md` §4.4 — 1/min
// per IP. Returns 429 RATE_LIMITED with a user-facing message that maps to
// the FE's copy. Keyed by IP (not userId) so a single admin spamming from
// multiple machines is still bound by their network egress.
const testSendLimiter = rateLimit({
    windowMs: 60_000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({
            success: false,
            message: 'Please wait before sending another test email.',
            errorCode: 'RATE_LIMITED',
        });
    },
});

const router = Router();

// All settings routes require authentication + admin role
router.use(authMiddleware);
router.use(adminGuard);

// Overview (for the main settings page with 5 cards)
router.get('/', settingsController.overview);

// General Configuration
router.get('/general', settingsController.getGeneralConfig);
router.put('/general', validate(UpdateGeneralConfigSchema), settingsController.updateGeneralConfig);

// Email Configuration (Brevo SMTP) — per email-config-settings-handover.md §4
// Specific subpaths BEFORE the catch-all GET/PUT to keep routing unambiguous.
router.get('/email/test-status', settingsController.getEmailTestStatus);
// Validation runs BEFORE the rate-limit so a malformed body returns 400
// VALIDATION_ERROR with a useful field-level message instead of burning the
// admin's one-per-minute slot on a typo.
router.post(
    '/email/test-send',
    validate(SendTestEmailSchema),
    testSendLimiter,
    settingsController.sendEmailTest,
);
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

// Staff Management
router.get('/staff', validate(ListStaffQuerySchema, 'query'), staffController.list);
router.post('/staff', validate(AddStaffSchema), staffController.add);
router.patch('/staff/:id/status', validate(ToggleStaffStatusSchema), staffController.toggleStatus);
router.post('/staff/:id/reset-password', staffController.resetPassword);
router.delete('/staff/:id', staffController.delete);

// GIATA Sync (admin)
// Order matters: specific routes BEFORE parameterized routes
router.post('/giata/sync-full', giataSyncController.triggerFullSync);
router.post('/giata/sync-incremental', giataSyncController.triggerIncrementalSync);
router.post('/giata/sync-hotel', giataSyncController.syncSingleHotel);  // hotelCode via query or body
router.post('/giata/resolve', giataSyncController.resolveGiataCodes);
router.get('/giata/status', giataSyncController.getStatus);
router.get('/giata/missing', giataSyncController.getMissingHotels);

export default router;
