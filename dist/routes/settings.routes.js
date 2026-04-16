"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const settings_controller_1 = __importDefault(require("../controllers/settings.controller"));
const giataSync_controller_1 = __importDefault(require("../controllers/giataSync.controller"));
const auth_middleware_1 = require("../middlewares/auth.middleware");
const validate_middleware_1 = require("../middlewares/validate.middleware");
const requestSchemas_1 = require("../validation/requestSchemas");
const router = (0, express_1.Router)();
// All settings routes require authentication
router.use(auth_middleware_1.authMiddleware);
// Overview (for the main settings page with 5 cards)
router.get('/', settings_controller_1.default.overview);
// General Configuration
router.get('/general', settings_controller_1.default.getGeneralConfig);
router.put('/general', (0, validate_middleware_1.validate)(requestSchemas_1.UpdateGeneralConfigSchema), settings_controller_1.default.updateGeneralConfig);
// Email Configuration
router.get('/email', settings_controller_1.default.getEmailConfig);
router.put('/email', (0, validate_middleware_1.validate)(requestSchemas_1.UpdateEmailConfigSchema), settings_controller_1.default.updateEmailConfig);
// Company Details
router.get('/company', settings_controller_1.default.getCompanyDetails);
router.put('/company', (0, validate_middleware_1.validate)(requestSchemas_1.UpdateCompanyDetailsSchema), settings_controller_1.default.updateCompanyDetails);
// Policies
router.get('/policies', settings_controller_1.default.getPolicies);
router.put('/policies', (0, validate_middleware_1.validate)(requestSchemas_1.UpdatePoliciesSchema), settings_controller_1.default.updatePolicies);
// Supplier Limits
router.get('/supplier-limits', (0, validate_middleware_1.validate)(requestSchemas_1.SupplierLimitsQuerySchema, 'query'), settings_controller_1.default.getSupplierLimits);
router.patch('/supplier-limits/:supplierCode', (0, validate_middleware_1.validate)(requestSchemas_1.UpdateSupplierLimitSchema), settings_controller_1.default.updateSupplierLimit);
// GIATA Sync (admin)
// Order matters: specific routes BEFORE parameterized routes
router.post('/giata/sync-full', giataSync_controller_1.default.triggerFullSync);
router.post('/giata/sync-incremental', giataSync_controller_1.default.triggerIncrementalSync);
router.post('/giata/sync-hotel', giataSync_controller_1.default.syncSingleHotel); // hotelCode via query or body
router.post('/giata/resolve', giataSync_controller_1.default.resolveGiataCodes);
router.get('/giata/status', giataSync_controller_1.default.getStatus);
router.get('/giata/missing', giataSync_controller_1.default.getMissingHotels);
exports.default = router;
