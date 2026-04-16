import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
type RequestLocation = 'body' | 'query' | 'params';
/**
 * Validates req[location] against the given Zod schema.
 * - Attaches parsed result to req.validated[location]
 * - Returns 400 with detailed Zod errors on failure
 */
export declare const validate: (schema: ZodSchema, location?: RequestLocation) => (req: Request, res: Response, next: NextFunction) => void;
export {};
