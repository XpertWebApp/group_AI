import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { sendResponse } from '../utils/response';

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendResponse(res, 401, null, 'No token provided', 'UNAUTHORIZED');
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        (req as any).user = decoded;
        next();
    } catch (error) {
        return sendResponse(res, 401, null, 'Invalid or expired token', 'UNAUTHORIZED');
    }
};
