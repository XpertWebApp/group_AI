import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { sendResponse } from '../utils/response';

export const validate = (schema: z.ZodSchema) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await schema.parseAsync({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            return next();
        } catch (error) {
            if (error instanceof ZodError) {
                return sendResponse(
                    res,
                    400,
                    null,
                    'Validation failed',
                    error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', '),
                );
            }
            return next(error);
        }
    };
};
