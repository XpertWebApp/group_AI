import { Request, Response, NextFunction } from 'express';
export declare class DashboardController {
    /**
     * GET /api/v1/dashboard/stats
     * Returns the 4 stat cards: Total Requests, Pending, Sent Offers, Declined.
     */
    stats(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/dashboard/recent-offers
     * Returns the recent offers table shown on the Dashboard.
     */
    recentOffers(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/dashboard/notifications
     * Returns in-app notifications (newest first). Pass ?unread=true for unread only.
     */
    notifications(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * PATCH /api/v1/dashboard/notifications/:id/read
     * Mark a single notification as read.
     */
    markNotificationRead(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * POST /api/v1/dashboard/notifications/read-all
     * Mark all notifications as read.
     */
    markAllNotificationsRead(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: DashboardController;
export default _default;
