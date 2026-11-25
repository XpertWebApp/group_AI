import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import odooController from '../controllers/odoo.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { OdooSearchQuerySchema } from '../validation/requestSchemas';

const router = Router();

// Sized for a debounced autocomplete: a single staff member typing
// continuously can hit ~1 req/sec; 60/min leaves comfortable headroom
// without letting a runaway FE hammer Odoo.
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

router.get(
    '/customers/search',
    authMiddleware,
    searchLimiter,
    validate(OdooSearchQuerySchema, 'query'),
    odooController.searchCustomers,
);

export default router;
