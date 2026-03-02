import { Router } from 'express';
import requestsController from '../controllers/requests.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    CreateBookingRequestSchema,
    UpdateBookingRequestSchema,
    CreateProposalSchema,
} from '../validation/requestSchemas';
import rateLimit from 'express-rate-limit';

const router = Router();

const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 50,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

// Booking Request CRUD
router.post(
    '/',
    authMiddleware,
    createLimiter,
    validate(CreateBookingRequestSchema, 'body'),
    requestsController.create,
);

router.get('/', authMiddleware, requestsController.list);

router.get('/:id', authMiddleware, requestsController.get);

router.get('/:id/summary', authMiddleware, requestsController.getSummary);

router.patch(
    '/:id',
    authMiddleware,
    validate(UpdateBookingRequestSchema, 'body'),
    requestsController.update,
);

// Create Proposal on a Request
router.post(
    '/:requestId/proposals',
    authMiddleware,
    validate(CreateProposalSchema, 'body'),
    requestsController.createProposal,
);

export default router;
