import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { sendResponse } from '../utils/response';

export const errorMiddleware = (
    err: any,
    req: Request,
    res: Response,
    _next: NextFunction,
) => {
    const statusCode = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    const errorCode = err.code || 'INTERNAL_ERROR';

    logger.error({
        msg: message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        errorCode,
    });

    return sendResponse(res, statusCode, null, message, errorCode);
};
