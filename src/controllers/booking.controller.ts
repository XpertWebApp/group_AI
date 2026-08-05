import { Request, Response, NextFunction } from 'express';
import wbeBookingService, { BookingFlowError } from '../services/wbeBooking.service';
import certificationSearchService from '../services/certificationSearch.service';
import bookingRepository from '../repositories/booking.repository';
import { sendResponse } from '../utils/response';
import logger from '../utils/logger';

/**
 * HTTP layer for the WBE booking flow.
 *
 * The endpoints mirror the WBE lifecycle one-to-one rather than collapsing it
 * into a single "book" call, because each step has a distinct failure mode the
 * caller must be able to react to — most importantly a price change at prebook,
 * which WBE requires the user to accept before booking may continue.
 */

/**
 * Map a booking-flow rule violation onto an HTTP status.
 *
 * These are client-correctable conditions, not server faults, so they must not
 * surface as 500s. AMBIGUOUS_BOOKING is the exception worth noting: 409 signals
 * that the caller must reconcile rather than retry, because a retry could
 * create a second reservation.
 */
function statusForFlowError(code: BookingFlowError['code']): number {
    switch (code) {
        case 'NOT_FOUND':
            return 404;
        case 'PASSENGER_MISMATCH':
            return 400;
        case 'ALREADY_PREBOOKED':
        case 'INVALID_STATE':
        case 'PRICE_CHANGE_UNACCEPTED':
        case 'AMBIGUOUS_BOOKING':
            return 409;
        case 'WBE_REJECTED':
            // Upstream refused a well-formed request — a bad gateway response
            // rather than a client error.
            return 502;
        default:
            return 500;
    }
}

/** Attach an HTTP status to a flow error and hand it to the error middleware. */
function forwardFlowError(err: unknown, next: NextFunction): void {
    if (err instanceof BookingFlowError) {
        (err as any).status = statusForFlowError(err.code);
        (err as any).code = err.code;
    }
    next(err);
}

export class BookingController {
    /**
     * POST /api/v1/bookings
     *
     * Persists a chosen search option as a draft booking. Nothing is sent to
     * WBE here — the row exists first so its AgencyReference can identify the
     * booking if a later BookV2 response is lost.
     */
    async selectOption(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;

            const booking = await wbeBookingService.selectOption({
                ...body,
                checkInDate: new Date(body.checkInDate),
                checkOutDate: new Date(body.checkOutDate),
                createdById: userId,
            });

            return sendResponse(res, 201, booking, 'Booking option selected');
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /**
     * POST /api/v1/bookings/:id/prebook
     *
     * Runs the mandatory OptionDetailsV2 call with Prebook=true. Permitted
     * exactly once per booking; a repeat returns 409.
     *
     * A `price_changed` status in the response means the price moved and the
     * caller must confirm acceptance before booking.
     */
    async prebook(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await wbeBookingService.prebook(id);

            const priceChanged = booking.status === 'price_changed';
            return sendResponse(
                res,
                200,
                booking,
                priceChanged
                    ? 'Prebook completed — the price changed and must be accepted before booking'
                    : 'Prebook completed',
            );
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /**
     * POST /api/v1/bookings/:id/accept-price-change
     *
     * Records the user's acceptance of a quoted → prebook price difference,
     * which WBE requires before the booking may proceed.
     */
    async acceptPriceChange(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await wbeBookingService.acceptPriceChange(id);
            return sendResponse(res, 200, booking, 'Price change accepted');
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /**
     * POST /api/v1/bookings/:id/book
     *
     * Dispatches BookV2. This creates a real reservation.
     *
     * Never retry a 409 AMBIGUOUS_BOOKING from this endpoint — the reservation
     * may already exist upstream. Call the reconcile endpoint instead.
     */
    async book(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await wbeBookingService.book(id);

            logger.info({
                msg: 'Booking created via API',
                bookingId: booking.id,
                bookingReference: booking.bookingReference,
                userId: (req as any).user?.id,
            });

            return sendResponse(res, 200, booking, 'Booking confirmed');
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /**
     * POST /api/v1/bookings/:id/reconcile
     *
     * Resolves a booking left in an ambiguous state by asking WBE what exists
     * under our AgencyReference. The safe alternative to re-dispatching BookV2.
     */
    async reconcile(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await wbeBookingService.reconcile(id);
            return sendResponse(
                res,
                200,
                booking,
                booking.bookingReference
                    ? 'Booking recovered from WBE'
                    : 'No booking exists at WBE for this agency reference',
            );
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /** POST /api/v1/bookings/:id/sync — refresh status from WBE. */
    async syncStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await wbeBookingService.syncStatus(id);
            return sendResponse(res, 200, booking, 'Booking status synced');
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /**
     * POST /api/v1/bookings/:id/voucher
     *
     * Issues the voucher for a confirmed booking. Kept separate from BookV2 so
     * booking and voucher remain independently controllable.
     */
    async issueVoucher(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await wbeBookingService.issueVoucher(id);
            return sendResponse(res, 200, booking, 'Voucher issued');
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /**
     * POST /api/v1/bookings/:id/cancel
     *
     * Cancels a booking. A `pending_cancellation` status in the response means
     * WBE could not settle it automatically and a human must confirm on their
     * side — it is not yet cancelled.
     */
    async cancel(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await wbeBookingService.cancel(id);

            const settled = booking.status === 'cancelled';
            return sendResponse(
                res,
                200,
                booking,
                settled
                    ? 'Booking cancelled'
                    : 'Cancellation requested — awaiting manual confirmation at WBE',
            );
        } catch (error) {
            return forwardFlowError(error, next);
        }
    }

    /** GET /api/v1/bookings/:id */
    async get(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params['id'] as string;
            const booking = await bookingRepository.findById(id);
            if (!booking) {
                return sendResponse(res, 404, null, 'Booking not found', 'NOT_FOUND');
            }
            return sendResponse(res, 200, booking, 'Booking retrieved');
        } catch (error) {
            return next(error);
        }
    }

    /** GET /api/v1/bookings — paginated list, certification runs excluded. */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const query = (req as any).validated?.query ?? req.query;
            const { items, total } = await bookingRepository.list(query);

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
                'Bookings retrieved',
            );
        } catch (error) {
            return next(error);
        }
    }

    /**
     * POST /api/v1/bookings/certification/search
     *
     * Raw WBE availability search with an exact room composition, including
     * children. Bypasses the group-search pipeline entirely: no supplier
     * filtering, price-band selection or markup, so certification observes the
     * unmodified supplier contract.
     */
    async certificationSearch(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const result = await certificationSearchService.search(body);
            return sendResponse(res, 200, result, 'Certification search completed');
        } catch (error: any) {
            // Composition errors are the caller's to fix, not server faults.
            if (error?.message?.startsWith('Invalid room composition')) {
                error.status = 400;
                error.code = 'INVALID_ROOM_COMPOSITION';
            }
            return next(error);
        }
    }

    /**
     * GET /api/v1/bookings/certification/report
     *
     * Lists certification bookings with their references, for transcribing
     * into WBE's certification document.
     */
    async certificationReport(_req: Request, res: Response, next: NextFunction) {
        try {
            const bookings = await bookingRepository.listCertificationBookings();

            const scenarios = bookings.map((b) => ({
                scenario: b.certificationScenario,
                bookingReference: b.bookingReference,
                agencyReference: b.agencyReference,
                status: b.status,
                wbeStatus: b.wbeStatus,
                hotelName: b.hotelName,
                checkInDate: b.checkInDate,
                nights: b.nights,
                nonRefundable: b.nonRefundable,
                totalPrice: b.totalPrice,
                currency: b.currency,
                rooms: b.rooms.map((r) => ({
                    roomId: r.roomId,
                    adultsNo: r.adultsNo,
                    childrenNo: r.childrenNo,
                    childAges: r.passengers.filter((p) => p.isChild).map((p) => p.age),
                })),
                lastError: b.lastError,
            }));

            return sendResponse(
                res,
                200,
                {
                    scenarios,
                    completed: scenarios.filter((s) => s.bookingReference).length,
                    total: scenarios.length,
                },
                'Certification report generated',
            );
        } catch (error) {
            return next(error);
        }
    }
}

export default new BookingController();
