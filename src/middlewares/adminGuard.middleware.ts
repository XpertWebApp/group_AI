import { Request, Response, NextFunction } from 'express';
import { sendResponse } from '../utils/response';

export const adminGuard = (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user || user.role !== 'ADMIN') {
        return sendResponse(res, 403, null, 'Admin access required', 'FORBIDDEN');
    }

    next();
};
