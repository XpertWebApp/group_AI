import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type RequestLocation = 'body' | 'query' | 'params';

/**
 * Validates req[location] against the given Zod schema.
 * - Attaches parsed result to req.validated[location]
 * - Returns 400 with detailed Zod errors on failure
 */
export const validate =
    (schema: ZodSchema, location: RequestLocation = 'body') =>
        (req: Request, res: Response, next: NextFunction): void => {
            const result = schema.safeParse(req[location]);

            if (!result.success) {
                const issues = result.error.issues ?? [];
                res.status(400).json({
                    error: {
                        code: 'validation_error',
                        message: 'Validation failed',
                        details: issues.map((e: any) => ({
                            path: Array.isArray(e.path) ? e.path.join('.') : String(e.path),
                            message: e.message,
                        })),
                    },
                });
                return;
            }

            if (!(req as any).validated) {
                (req as any).validated = {};
            }
            (req as any).validated[location] = result.data;
            next();
        };
