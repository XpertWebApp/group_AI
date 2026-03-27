import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { sendResponse } from '../utils/response';
import userRepository from '../repositories/user.repository';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendResponse(res, 401, null, 'No token provided', 'UNAUTHORIZED');
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded: any = jwt.verify(token, config.jwt.secret as string);

        // Verify user still exists and is active in the database
        const user = await userRepository.findById(decoded.id);
        if (!user) {
            return sendResponse(res, 401, null, 'Account has been deleted', 'UNAUTHORIZED');
        }
        if (!user.isActive) {
            return sendResponse(res, 401, null, 'Account has been blocked', 'UNAUTHORIZED');
        }

        // Attach fresh role from DB (in case role changed since token was issued)
        (req as any).user = {
            id: decoded.id,
            email: decoded.email,
            role: (user as any).role.name,
        };
        next();
    } catch (error) {
        return sendResponse(res, 401, null, 'Invalid or expired token', 'UNAUTHORIZED');
    }
};
