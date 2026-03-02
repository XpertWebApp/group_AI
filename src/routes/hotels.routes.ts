import { Router } from 'express';
import hotelController from '../controllers/hotel.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { HotelSearchQuerySchema } from '../validation/requestSchemas';
import rateLimit from 'express-rate-limit';

const router = Router();

const searchLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

router.get(
    '/search',
    authMiddleware,
    searchLimiter,
    validate(HotelSearchQuerySchema, 'query'),
    hotelController.search,
);

export default router;
