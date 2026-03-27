import { Request, Response, NextFunction } from 'express';
import staffService from '../services/staff.service';
import { sendResponse } from '../utils/response';

export class StaffController {
    /** GET /api/v1/settings/staff */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const query = (req as any).validated?.query ?? req.query;
            const result = await staffService.listStaff({
                search: query.search,
                status: query.status,
                page: query.page,
                limit: query.limit,
            });
            return sendResponse(res, 200, result, 'Staff list retrieved');
        } catch (error) {
            next(error);
        }
    }

    /** POST /api/v1/settings/staff */
    async add(req: Request, res: Response, next: NextFunction) {
        try {
            const data = (req as any).validated.body;
            const adminUserId = (req as any).user.id;
            const result = await staffService.addStaff(data, adminUserId);
            return sendResponse(res, 201, result, 'Staff added successfully');
        } catch (error) {
            next(error);
        }
    }

    /** PATCH /api/v1/settings/staff/:id/status */
    async toggleStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params.id as string;
            const { action } = (req as any).validated.body;
            const adminUserId = (req as any).user.id;
            const result = await staffService.toggleStaffStatus(id, action, adminUserId);
            const message = action === 'block' ? 'Staff member blocked' : 'Staff member unblocked';
            return sendResponse(res, 200, result, message);
        } catch (error) {
            next(error);
        }
    }

    /** POST /api/v1/settings/staff/:id/reset-password */
    async resetPassword(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params.id as string;
            const adminUserId = (req as any).user.id;
            const result = await staffService.resetPassword(id, adminUserId);
            return sendResponse(res, 200, result, 'Password reset successfully');
        } catch (error) {
            next(error);
        }
    }

    /** DELETE /api/v1/settings/staff/:id */
    async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params.id as string;
            const adminUserId = (req as any).user.id;
            await staffService.deleteStaff(id, adminUserId);
            return sendResponse(res, 200, null, 'Staff member deleted');
        } catch (error) {
            next(error);
        }
    }
}

export default new StaffController();
