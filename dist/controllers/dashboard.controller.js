"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardController = void 0;
const dashboard_service_1 = __importDefault(require("../services/dashboard.service"));
const notification_repository_1 = __importDefault(require("../repositories/notification.repository"));
const response_1 = require("../utils/response");
class DashboardController {
    /**
     * GET /api/v1/dashboard/stats
     * Returns the 4 stat cards: Total Requests, Pending, Sent Offers, Declined.
     */
    async stats(req, res, next) {
        try {
            const result = await dashboard_service_1.default.getStats();
            return (0, response_1.sendResponse)(res, 200, result, 'Dashboard stats retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * GET /api/v1/dashboard/recent-offers
     * Returns the recent offers table shown on the Dashboard.
     */
    async recentOffers(req, res, next) {
        try {
            const limit = req.query['limit'] ? Math.min(Number(req.query['limit']), 50) : 10;
            const result = await dashboard_service_1.default.getRecentOffers(limit);
            return (0, response_1.sendResponse)(res, 200, result, 'Recent offers retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * GET /api/v1/dashboard/notifications
     * Returns in-app notifications (newest first). Pass ?unread=true for unread only.
     */
    async notifications(req, res, next) {
        try {
            const unreadOnly = req.query['unread'] === 'true';
            const limit = req.query['limit'] ? Math.min(Number(req.query['limit']), 100) : 50;
            const result = await notification_repository_1.default.findAll({ unreadOnly, limit });
            const unreadCount = await notification_repository_1.default.unreadCount();
            return (0, response_1.sendResponse)(res, 200, { notifications: result, unreadCount }, 'Notifications retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * PATCH /api/v1/dashboard/notifications/:id/read
     * Mark a single notification as read.
     */
    async markNotificationRead(req, res, next) {
        try {
            const result = await notification_repository_1.default.markRead(req.params['id']);
            return (0, response_1.sendResponse)(res, 200, result, 'Notification marked as read');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * POST /api/v1/dashboard/notifications/read-all
     * Mark all notifications as read.
     */
    async markAllNotificationsRead(req, res, next) {
        try {
            await notification_repository_1.default.markAllRead();
            return (0, response_1.sendResponse)(res, 200, { success: true }, 'All notifications marked as read');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.DashboardController = DashboardController;
exports.default = new DashboardController();
