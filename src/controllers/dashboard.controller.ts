import { Request, Response, NextFunction } from 'express';
import dashboardService from '../services/dashboard.service';
import notificationRepository from '../repositories/notification.repository';
import { sendResponse } from '../utils/response';

export class DashboardController {
    /**
     * GET /api/v1/dashboard/stats
     * Returns the 4 stat cards: Total Requests, Pending, Sent Offers, Declined.
     */
    async stats(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await dashboardService.getStats();
            return sendResponse(res, 200, result, 'Dashboard stats retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/dashboard/recent-offers
     * Returns the recent offers table shown on the Dashboard.
     */
    async recentOffers(req: Request, res: Response, next: NextFunction) {
        try {
            const limit = req.query['limit'] ? Math.min(Number(req.query['limit']), 50) : 10;
            const result = await dashboardService.getRecentOffers(limit);
            return sendResponse(res, 200, result, 'Recent offers retrieved');
        } catch (error) {
            next(error);
        }
    }
    /**
     * GET /api/v1/dashboard/notifications
     * Returns in-app notifications (newest first). Pass ?unread=true for unread only.
     */
    async notifications(req: Request, res: Response, next: NextFunction) {
        try {
            const unreadOnly = req.query['unread'] === 'true';
            const limit = req.query['limit'] ? Math.min(Number(req.query['limit']), 100) : 50;
            const result = await notificationRepository.findAll({ unreadOnly, limit });
            const unreadCount = await notificationRepository.unreadCount();
            return sendResponse(res, 200, { notifications: result, unreadCount }, 'Notifications retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * PATCH /api/v1/dashboard/notifications/:id/read
     * Mark a single notification as read.
     */
    async markNotificationRead(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await notificationRepository.markRead(req.params['id'] as string);
            return sendResponse(res, 200, result, 'Notification marked as read');
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/dashboard/notifications/read-all
     * Mark all notifications as read.
     */
    async markAllNotificationsRead(req: Request, res: Response, next: NextFunction) {
        try {
            await notificationRepository.markAllRead();
            return sendResponse(res, 200, { success: true }, 'All notifications marked as read');
        } catch (error) {
            next(error);
        }
    }
}

export default new DashboardController();
