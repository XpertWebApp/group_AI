import { Request, Response, NextFunction } from 'express';
import authService from '../services/auth.service';
import { sendResponse } from '../utils/response';

export class AuthController {
    async login(req: Request, res: Response, next: NextFunction) {
        try {
            const { email, password } = req.body;
            const result = await authService.login(email, password);
            return sendResponse(res, 200, result, 'Login successful');
        } catch (error) {
            next(error);
        }
    }

    async refresh(req: Request, res: Response, next: NextFunction) {
        try {
            const { refreshToken } = req.body;
            const result = await authService.refresh(refreshToken);
            return sendResponse(res, 200, result, 'Token refreshed');
        } catch (error) {
            next(error);
        }
    }

    async logout(req: Request, res: Response, next: NextFunction) {
        try {
            const user = (req as any).user;
            if (user && user.id) {
                await authService.logout(user.id);
            }
            return sendResponse(res, 200, null, 'Logout successful');
        } catch (error) {
            next(error);
        }
    }
}

export default new AuthController();
