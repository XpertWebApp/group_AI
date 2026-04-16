"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = void 0;
/**
 * Validates req[location] against the given Zod schema.
 * - Attaches parsed result to req.validated[location]
 * - Returns 400 with detailed Zod errors on failure
 */
const validate = (schema, location = 'body') => (req, res, next) => {
    const result = schema.safeParse(req[location]);
    if (!result.success) {
        const issues = result.error.issues ?? [];
        res.status(400).json({
            error: {
                code: 'validation_error',
                message: 'Validation failed',
                details: issues.map((e) => ({
                    path: Array.isArray(e.path) ? e.path.join('.') : String(e.path),
                    message: e.message,
                })),
            },
        });
        return;
    }
    if (!req.validated) {
        req.validated = {};
    }
    req.validated[location] = result.data;
    next();
};
exports.validate = validate;
