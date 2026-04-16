"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const staticData_service_1 = __importDefault(require("../services/staticData.service"));
const response_1 = require("../utils/response");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const logger_1 = __importDefault(require("../utils/logger"));
const router = (0, express_1.Router)();
// Trigger full sync - Admin only
router.post('/sync', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        console.log('--- ADMIN SYNC ROUTE HIT ---');
        logger_1.default.info('Admin Sync route triggered');
        // Start sync in background
        staticData_service_1.default.fullSync().catch(err => {
            logger_1.default.error({ msg: 'Background fullSync failed caught in route', error: err.message });
        });
        console.log('Response being sent...');
        return (0, response_1.sendResponse)(res, 202, null, 'Sync started in background');
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
