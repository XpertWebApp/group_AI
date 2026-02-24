import { Router } from 'express';
import requestsController from '../controllers/requests.controller';
import hotelSearchController from '../controllers/hotelSearch.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    CreateBookingRequestSchema,
    UpdateBookingRequestSchema,
    ListRequestsQuerySchema,
} from '../validation/requestSchemas';
import rateLimit from 'express-rate-limit';

const router = Router();

const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 50,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

// Rate limiter for WBE search calls (expensive external API)
const searchLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    max: 10,
    message: { error: { code: 'rate_limited', message: 'Too many search requests, try again later' } },
});

// ── Booking Request CRUD ───────────────────────────────────────────────────

router.post(
    '/',
    authMiddleware,
    createLimiter,
    validate(CreateBookingRequestSchema, 'body'),
    requestsController.create,
);

router.get('/', authMiddleware, validate(ListRequestsQuerySchema, 'query'), requestsController.list);

router.get('/:id', authMiddleware, requestsController.get);

router.get('/:id/summary', authMiddleware, requestsController.getSummary);

router.patch(
    '/:id',
    authMiddleware,
    validate(UpdateBookingRequestSchema, 'body'),
    requestsController.update,
);


export default router;
