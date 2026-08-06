import { Request, Response, NextFunction } from 'express';

import groupBookingService, { GroupBookingError } from '../services/groupBooking.service';
import bookingGroupRepository from '../repositories/bookingGroup.repository';
import groupReviewService, { GroupReviewError } from '../services/groupReview.service';
import { sendResponse } from '../utils/response';

/**
 * HTTP layer for group bookings.
 *
 * One call here can create several reservations, so the responses are shaped
 * around the outcome rather than around whether the request succeeded: a group
 * that booked nine of ten rooms is neither a success nor a failure, and the
 * caller has to be able to tell the difference without parsing prose.
 */

/**
 * Map a group-booking refusal onto an HTTP status.
 *
 * Every one of these is raised before any reservation exists, so they are all
 * safe to retry once the underlying condition is addressed — unlike the
 * booking-flow errors, where a retry can double-book.
 */
function statusForGroupError(code: GroupBookingError['code']): number {
    switch (code) {
        case 'PROPOSAL_NOT_BOOKABLE':
            return 404;
        case 'NO_AVAILABILITY':
            // The request was well-formed; the supplier simply has nothing.
            return 409;
        case 'PRICE_DRIFT_EXCEEDED':
        case 'TOO_MANY_SLICES':
            // Both need an operator decision — accept the drift, or pick a
            // different hotel — so they are conflicts rather than bad input.
            return 409;
        case 'ALREADY_BOOKED':
            return 409;
        default:
            return 500;
    }
}

/**
 * Map a review refusal onto an HTTP status.
 *
 * NOT_REVIEWED and REVIEW_REJECTED are 409 rather than 403: the caller is
 * permitted to send offers, but this particular one is not ready — a state to
 * be resolved, not an authorisation failure.
 */
function statusForReviewError(code: GroupReviewError['code']): number {
    switch (code) {
        case 'GROUP_NOT_FOUND':
            return 404;
        case 'NOT_BOOKED':
        case 'ALREADY_REVIEWED':
        case 'NOT_REVIEWED':
        case 'REVIEW_REJECTED':
            return 409;
        default:
            return 500;
    }
}

function forwardReviewError(err: unknown, next: NextFunction): void {
    if (err instanceof GroupReviewError) {
        (err as any).status = statusForReviewError(err.code);
        (err as any).code = err.code;
        (err as any).details = err.details;
    }
    next(err);
}

function forwardGroupError(err: unknown, next: NextFunction): void {
    if (err instanceof GroupBookingError) {
        (err as any).status = statusForGroupError(err.code);
        (err as any).code = err.code;
        (err as any).details = err.details;
    }
    next(err);
}

export class BookingGroupController {
    /**
     * POST /api/v1/booking-groups
     *
     * Books a hotel for a whole group, splitting the rooms across suppliers.
     *
     * Returns 201 when every room was confirmed and 207 when only some were:
     * a part-booked group is a real result that has to be acted on, and
     * reporting it as a plain success would let a shortfall reach the customer
     * unnoticed.
     */
    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;

            const group = await groupBookingService.bookGroup({
                ...body,
                checkInDate: new Date(body.checkInDate),
                createdById: userId,
            });

            const complete = group.roomsConfirmed >= group.roomsRequested;

            return sendResponse(
                res,
                complete ? 201 : 207,
                group,
                complete
                    ? 'Group booked'
                    : `Group partially booked — ${group.roomsConfirmed} of ` +
                      `${group.roomsRequested} rooms confirmed. ${group.shortfallNote ?? ''}`.trim(),
            );
        } catch (error) {
            return forwardGroupError(error, next);
        }
    }

    /** GET /api/v1/booking-groups — paginated list for the staff dashboard. */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const query = (req as any).validated?.query ?? req.query;
            const { items, total } = await bookingGroupRepository.list(query);

            return sendResponse(
                res,
                200,
                {
                    items,
                    pagination: {
                        page: query.page,
                        limit: query.limit,
                        total,
                        totalPages: Math.ceil(total / query.limit),
                    },
                },
                'Booking groups retrieved',
            );
        } catch (error) {
            return next(error);
        }
    }

    /**
     * GET /api/v1/booking-groups/partial
     *
     * Groups holding some rooms but not all. This is a worklist rather than a
     * filtered list: every row on it needs a person to source the missing
     * rooms, which is why it is its own endpoint and not a query parameter.
     *
     * Declared before `/:id` so the literal path is not captured by it.
     */
    async partial(_req: Request, res: Response, next: NextFunction) {
        try {
            const groups = await bookingGroupRepository.findPartial();

            return sendResponse(
                res,
                200,
                groups.map((g) => ({
                    id: g.id,
                    groupReference: g.groupReference,
                    hotelName: g.hotelName,
                    checkInDate: g.checkInDate,
                    roomsConfirmed: g.roomsConfirmed,
                    roomsRequested: g.roomsRequested,
                    shortfall: g.roomsRequested - g.roomsConfirmed,
                    shortfallNote: g.shortfallNote,
                    requestId: g.requestId,
                })),
                'Groups awaiting manual completion',
            );
        } catch (error) {
            return next(error);
        }
    }

    /** GET /api/v1/booking-groups/:id — the group with all of its slices. */
    async get(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const group = await bookingGroupRepository.findById(id);

            if (!group) {
                return sendResponse(res, 404, null, 'Booking group not found', 'NOT_FOUND');
            }

            return sendResponse(res, 200, group, 'Booking group retrieved');
        } catch (error) {
            return next(error);
        }
    }

    /**
     * POST /api/v1/booking-groups/:id/cancel
     *
     * Cancels every confirmed slice. Returns 200 even when some cancellations
     * were refused: the attempt was made on all of them and the resulting
     * status says what actually happened, which is more useful to the caller
     * than an error that hides which slices did cancel.
     */
    async cancel(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const group = await groupBookingService.cancelGroup(id);

            const settled = group.status === 'cancelled';

            return sendResponse(
                res,
                200,
                group,
                settled
                    ? 'Group cancelled'
                    : 'Cancellation attempted on every confirmed booking; some are not yet settled',
            );
        } catch (error) {
            return forwardGroupError(error, next);
        }
    }

    /**
     * GET /api/v1/booking-groups/:id/review
     *
     * Everything the group handler has to check, in one sheet. Items the system
     * can verify carry their finding; items only a person can judge are marked
     * as such rather than quietly passed.
     */
    async reviewSheet(req: Request, res: Response, next: NextFunction) {
        try {
            const sheet = await groupReviewService.buildReviewSheet(req.params['id'] as string);
            return sendResponse(res, 200, sheet, 'Review sheet retrieved');
        } catch (error) {
            return forwardReviewError(error, next);
        }
    }

    /**
     * POST /api/v1/booking-groups/:id/review/approve
     *
     * Record the handler's sign-off. Until this exists the customer-facing
     * offer cannot be sent.
     */
    async approveReview(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const sheet = await groupReviewService.approve(
                req.params['id'] as string,
                (req as any).user?.id,
                body?.notes,
            );
            return sendResponse(res, 200, sheet, 'Booking approved — the offer may now be sent');
        } catch (error) {
            return forwardReviewError(error, next);
        }
    }

    /** POST /api/v1/booking-groups/:id/review/reject — refuse, with a reason. */
    async rejectReview(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const sheet = await groupReviewService.reject(
                req.params['id'] as string,
                (req as any).user?.id,
                body.reason,
            );
            return sendResponse(res, 200, sheet, 'Booking rejected at review');
        } catch (error) {
            return forwardReviewError(error, next);
        }
    }

    /** GET /api/v1/booking-groups/awaiting-review — the handler's worklist. */
    async awaitingReview(_req: Request, res: Response, next: NextFunction) {
        try {
            const groups = await groupReviewService.findAwaitingReview();
            return sendResponse(
                res,
                200,
                groups.map((g) => ({
                    id: g.id,
                    groupReference: g.groupReference,
                    hotelName: g.hotelName,
                    checkInDate: g.checkInDate,
                    status: g.status,
                    roomsConfirmed: g.roomsConfirmed,
                    roomsRequested: g.roomsRequested,
                    bookedAt: g.createdAt,
                })),
                'Groups awaiting review',
            );
        } catch (error) {
            return next(error);
        }
    }

    /** GET /api/v1/booking-groups/by-request/:id — every group for a request. */
    async byRequest(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const groups = await bookingGroupRepository.findByRequest(id);

            return sendResponse(res, 200, groups, 'Booking groups retrieved');
        } catch (error) {
            return next(error);
        }
    }
}

export default new BookingGroupController();
