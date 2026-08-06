import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import optionSelectionController from '../controllers/optionSelection.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    SelectionTokenParamSchema,
    SubmitSelectionSchema,
} from '../validation/optionSelectionSchemas';

const router = Router();

/**
 * Customer-facing selection routes.
 *
 * These are the only endpoints in the system reached without a login: the
 * customer holding a selection link has no account, and requiring one would put
 * a signup between an agent and the offer they asked for. The token is the
 * credential, which is why it is 24 random bytes rather than anything derived.
 */

/**
 * Rate limit for viewing a link.
 *
 * Tighter than the authenticated routes because there is no account behind the
 * request. A token cannot realistically be guessed, but the limit bounds what a
 * scripted attempt costs us in database lookups.
 */
const viewLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        error: { code: 'rate_limited', message: 'Too many requests, try again shortly' },
    },
});

/**
 * Tighter still on submission: a selection starts a booking, and a customer
 * has no legitimate reason to submit more than a handful of times a minute.
 */
const submitLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: {
        error: { code: 'rate_limited', message: 'Too many attempts, try again shortly' },
    },
});

/** The options behind a selection link, with the conditions attached to each. */
router.get(
    '/:token',
    viewLimiter,
    validate(SelectionTokenParamSchema, 'params'),
    optionSelectionController.viewOptions,
);

/**
 * Record the customer's choice.
 *
 * A non-refundable rate is refused unless `acceptTerms` is true — the client's
 * requirement is that such a commitment cannot be made by implication.
 */
router.post(
    '/:token',
    submitLimiter,
    validate(SelectionTokenParamSchema, 'params'),
    validate(SubmitSelectionSchema, 'body'),
    optionSelectionController.submitSelection,
);

export default router;

/**
 * Staff-facing selection routes, mounted separately because they require a
 * login. Kept in this file so the two halves of the same feature stay together.
 */
export const staffSelectionRouter = Router();

/**
 * Run the booking sequence for a recorded selection: Odoo sales order,
 * availability check, booking, then the reservation references back to Odoo.
 *
 * Shares the submit limiter's intent — this commits money — but is separate
 * because it is triggered by staff rather than by a customer, and one call can
 * dispatch several reservations.
 */
staffSelectionRouter.post(
    '/:id/book',
    authMiddleware,
    rateLimit({
        windowMs: 60 * 1000,
        max: 10,
        message: {
            error: { code: 'rate_limited', message: 'Too many booking operations, try again shortly' },
        },
    }),
    optionSelectionController.bookSelection,
);

/** Withdraw a selection so a different option can be chosen. */
staffSelectionRouter.delete('/:id', authMiddleware, optionSelectionController.withdraw);
