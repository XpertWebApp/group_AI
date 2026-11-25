import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bookingController from '../controllers/booking.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    SelectOptionSchema,
    CertificationSearchSchema,
    ListBookingsSchema,
    BookingIdParamSchema,
} from '../validation/bookingSchemas';

const router = Router();

/**
 * Routes for the WBE booking lifecycle.
 *
 * Every route requires authentication: these endpoints create real
 * reservations against a credit line, so none of them may be anonymous.
 */

/**
 * Deliberately tight limit on the endpoints that reserve or spend: prebook
 * holds inventory, book and voucher commit money. The cap is low enough that a
 * runaway client or a double-submitting UI cannot rack up reservations before
 * anyone notices. The state machine already prevents duplicates for a single
 * booking; this bounds the damage across many.
 */
const bookingActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: {
        error: { code: 'rate_limited', message: 'Too many booking operations, try again shortly' },
    },
});

/** WBE search calls are expensive upstream, so they get their own budget. */
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: {
        error: { code: 'rate_limited', message: 'Too many search requests, try again shortly' },
    },
});

// ── Certification ────────────────────────────────────────────────────────────
// Declared before `/:id` so these literal paths are not captured by the
// UUID parameter route.

router.post(
    '/certification/search',
    authMiddleware,
    searchLimiter,
    validate(CertificationSearchSchema, 'body'),
    bookingController.certificationSearch,
);

router.get('/certification/report', authMiddleware, bookingController.certificationReport);

// ── Booking lifecycle ────────────────────────────────────────────────────────

/** Persist a chosen option as a draft booking. Does not contact WBE. */
router.post(
    '/',
    authMiddleware,
    bookingActionLimiter,
    validate(SelectOptionSchema, 'body'),
    bookingController.selectOption,
);

router.get('/', authMiddleware, validate(ListBookingsSchema, 'query'), bookingController.list);

router.get('/:id', authMiddleware, validate(BookingIdParamSchema, 'params'), bookingController.get);

/** Mandatory OptionDetailsV2 with Prebook=true. Permitted once per booking. */
router.post(
    '/:id/prebook',
    authMiddleware,
    bookingActionLimiter,
    validate(BookingIdParamSchema, 'params'),
    bookingController.prebook,
);

/** Accept a quoted → prebook price difference, as WBE requires. */
router.post(
    '/:id/accept-price-change',
    authMiddleware,
    validate(BookingIdParamSchema, 'params'),
    bookingController.acceptPriceChange,
);

/** Dispatch BookV2. Creates a real reservation; a 409 must not be retried. */
router.post(
    '/:id/book',
    authMiddleware,
    bookingActionLimiter,
    validate(BookingIdParamSchema, 'params'),
    bookingController.book,
);

/** Resolve an ambiguous dispatch by looking the booking up at WBE. */
router.post(
    '/:id/reconcile',
    authMiddleware,
    validate(BookingIdParamSchema, 'params'),
    bookingController.reconcile,
);

/** Refresh status from WBE. Read-only upstream. */
router.post(
    '/:id/sync',
    authMiddleware,
    validate(BookingIdParamSchema, 'params'),
    bookingController.syncStatus,
);

router.post(
    '/:id/voucher',
    authMiddleware,
    bookingActionLimiter,
    validate(BookingIdParamSchema, 'params'),
    bookingController.issueVoucher,
);

router.post(
    '/:id/cancel',
    authMiddleware,
    bookingActionLimiter,
    validate(BookingIdParamSchema, 'params'),
    bookingController.cancel,
);

export default router;
