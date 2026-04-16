"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dashboard_controller_1 = __importDefault(require("../controllers/dashboard.controller"));
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = (0, express_1.Router)();
router.get('/stats', auth_middleware_1.authMiddleware, dashboard_controller_1.default.stats);
router.get('/recent-offers', auth_middleware_1.authMiddleware, dashboard_controller_1.default.recentOffers);
router.get('/notifications', auth_middleware_1.authMiddleware, dashboard_controller_1.default.notifications);
router.patch('/notifications/:id/read', auth_middleware_1.authMiddleware, dashboard_controller_1.default.markNotificationRead);
router.post('/notifications/read-all', auth_middleware_1.authMiddleware, dashboard_controller_1.default.markAllNotificationsRead);
exports.default = router;
