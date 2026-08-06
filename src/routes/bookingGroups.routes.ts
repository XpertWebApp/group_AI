import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import bookingGroupController from '../controllers/bookingGroup.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    CreateBookingGroupSchema,
    ListBookingGroupsSchema,
    BookingGroupIdParamSchema,
    ApproveReviewSchema,
    RejectReviewSchema,
} from '../validation/bookingGroupSchemas';

const router = Router();

/**
 * Routes for booking a group across several suppliers.
 *
 * Every route requires authentication: one call here can create a dozen real
 * reservations against a credit line.
 */

/**
 * Tighter than the per-booking limiter, because each call multiplies.
 *
 * A single request to this endpoint can dispatch several BookV2 calls, so ten
 * requests a minute is already up to sixty reservations. The cap bounds what a
 * double-submitting UI or a stuck retry loop can commit before anyone notices.
 */
const groupBookingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: {
        error: {
            code: 'rate_limited',
            message: 'Too many group booking operations, try again shortly',
        },
    },
});

// ── Worklist ────────────────────────────────────────────────────────────────
// Declared before `/:id` so this literal path is not captured by the UUID
// parameter route.

/** Groups holding some rooms but not all — the queue a staff member works. */
router.get('/partial', authMiddleware, bookingGroupController.partial);

/** Booked groups waiting for a group handler to check them. */
router.get('/awaiting-review', authMiddleware, bookingGroupController.awaitingReview);

/** Every group raised against one request. */
router.get('/by-request/:id', authMiddleware, bookingGroupController.byRequest);

// ── Group lifecycle ─────────────────────────────────────────────────────────

/**
 * Book a hotel for a whole group. Re-searches for current availability, splits
 * the rooms across suppliers and books each slice.
 *
 * 201 when every room was confirmed, 207 when only some were.
 */
router.post(
    '/',
    authMiddleware,
    groupBookingLimiter,
    validate(CreateBookingGroupSchema, 'body'),
    bookingGroupController.create,
);

router.get(
    '/',
    authMiddleware,
    validate(ListBookingGroupsSchema, 'query'),
    bookingGroupController.list,
);

router.get(
    '/:id',
    authMiddleware,
    validate(BookingGroupIdParamSchema, 'params'),
    bookingGroupController.get,
);

// ── Group handler review ────────────────────────────────────────────────────
// The gate the client requires before a customer-facing offer goes out.

/** Everything the handler has to check, assembled into one sheet. */
router.get(
    '/:id/review',
    authMiddleware,
    validate(BookingGroupIdParamSchema, 'params'),
    bookingGroupController.reviewSheet,
);

router.post(
    '/:id/review/approve',
    authMiddleware,
    validate(BookingGroupIdParamSchema, 'params'),
    validate(ApproveReviewSchema, 'body'),
    bookingGroupController.approveReview,
);

router.post(
    '/:id/review/reject',
    authMiddleware,
    validate(BookingGroupIdParamSchema, 'params'),
    validate(RejectReviewSchema, 'body'),
    bookingGroupController.rejectReview,
);

/** Cancel every confirmed slice of the group. */
router.post(
    '/:id/cancel',
    authMiddleware,
    groupBookingLimiter,
    validate(BookingGroupIdParamSchema, 'params'),
    bookingGroupController.cancel,
);

export default router;
