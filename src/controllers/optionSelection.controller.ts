import { Request, Response, NextFunction } from 'express';

import optionSelectionService, {
    OptionSelectionError,
} from '../services/optionSelection.service';
import selectionToBookingService from '../services/selectionToBooking.service';
import { sendResponse } from '../utils/response';

/**
 * HTTP layer for option selection.
 *
 * The customer-facing routes are reached without a login: the token in the
 * selection link is the credential. That shapes two things here. Responses
 * carry only what a customer is entitled to see — never buying rates or
 * margins, which live on the same records. And a bad token is answered the same
 * way whether it never existed or has already been used, so the endpoint cannot
 * be used to probe for valid links.
 */

function statusForSelectionError(code: OptionSelectionError['code']): number {
    switch (code) {
        case 'SELECTION_NOT_FOUND':
            return 404;
        case 'PROPOSAL_NOT_SENT':
        case 'OPTION_NOT_IN_OFFER':
            return 400;
        case 'TERMS_NOT_ACCEPTED':
            // The request was well-formed; what is missing is the customer's
            // acceptance, which is a precondition rather than bad input.
            return 409;
        case 'ALREADY_SELECTED':
        case 'LOCK_EXPIRED':
            return 409;
        default:
            return 500;
    }
}

function forwardSelectionError(err: unknown, next: NextFunction): void {
    if (err instanceof OptionSelectionError) {
        (err as any).status = statusForSelectionError(err.code);
        (err as any).code = err.code;
        (err as any).details = err.details;
    }
    next(err);
}

/**
 * Reduce a proposal hotel to what the customer may see.
 *
 * The proposal carries both the buying and the selling price. Only the selling
 * price belongs in a customer-facing response, and the filtering happens here
 * rather than in the query so that adding a field to the model cannot leak it
 * by default.
 */
function toCustomerOption(hotel: {
    hotelCode: string;
    hotelName: string | null;
    totalPrice: unknown;
    currency: string;
    rooms: unknown;
    starRating: number | null;
    address: string | null;
    addressCity: string | null;
    freeCancellation: boolean | null;
    cancelDeadline: Date | null;
    cancelDeadlineOverride: Date | null;
}) {
    const deadline = hotel.cancelDeadlineOverride ?? hotel.cancelDeadline;
    // Absent means unknown, and an unknown cancellation policy is presented as
    // non-refundable — the same reading the service applies when deciding
    // whether explicit acceptance is required.
    const nonRefundable = hotel.freeCancellation !== true;

    return {
        hotelCode: hotel.hotelCode,
        hotelName: hotel.hotelName,
        starRating: hotel.starRating,
        address: hotel.address,
        city: hotel.addressCity,
        rooms: hotel.rooms,
        totalPrice: Number(hotel.totalPrice),
        currency: hotel.currency,
        nonRefundable,
        cancellationDeadline: deadline ? deadline.toISOString() : null,
        cancellationPolicy: nonRefundable
            ? 'Non-refundable. This booking cannot be cancelled or amended without charge.'
            : deadline
              ? `Free cancellation until ${deadline.toISOString().slice(0, 10)}.`
              : 'Free cancellation, deadline to be confirmed.',
        /**
         * Whether the customer must tick the acceptance before this option can
         * be chosen. Sent so the page can require it, rather than leaving the
         * frontend to re-derive the rule and get it wrong.
         */
        requiresExplicitAcceptance: nonRefundable,
    };
}

export class OptionSelectionController {
    /**
     * GET /api/v1/select/:token
     *
     * The options behind a customer's selection link, with the conditions
     * attached to each. Public — the token is the credential.
     */
    async viewOptions(req: Request, res: Response, next: NextFunction) {
        try {
            const token = req.params['token'] as string;
            const { proposal, selection } = await optionSelectionService.findByToken(token);

            return sendResponse(
                res,
                200,
                {
                    proposalId: proposal.id,
                    options: proposal.hotels.map(toCustomerOption),
                    // Null until the customer chooses. Present afterwards so a
                    // returning visitor sees their choice rather than being
                    // invited to make a second one.
                    selected: selection
                        ? {
                              hotelCode: selection.hotelCode,
                              hotelName: selection.hotelName,
                              selectedAt: selection.selectedAt,
                              nonRefundable: selection.nonRefundable,
                          }
                        : null,
                    priceHeldUntil: selection?.lockedUntil ?? null,
                },
                'Offer options retrieved',
            );
        } catch (error) {
            return forwardSelectionError(error, next);
        }
    }

    /**
     * POST /api/v1/select/:token
     *
     * Record the customer's choice. This is the point the booking process
     * starts, so the address and agent are captured for the acceptance record.
     */
    async submitSelection(req: Request, res: Response, next: NextFunction) {
        try {
            const token = req.params['token'] as string;
            const body = (req as any).validated?.body ?? req.body;

            const { proposal } = await optionSelectionService.findByToken(token);

            const selection = await optionSelectionService.selectOption({
                proposalId: proposal.id,
                hotelCode: body.hotelCode,
                acceptTerms: body.acceptTerms,
                selectedByEmail: body.selectedByEmail,
                // Behind a proxy Express reports the forwarded address, which
                // is the customer's rather than the load balancer's.
                acceptedFromIp: req.ip,
                acceptedUserAgent: req.get('user-agent'),
            });

            return sendResponse(
                res,
                201,
                {
                    hotelCode: selection.hotelCode,
                    hotelName: selection.hotelName,
                    totalPrice: Number(selection.acceptedTotal ?? 0),
                    currency: selection.currency,
                    nonRefundable: selection.nonRefundable,
                    selectedAt: selection.selectedAt,
                },
                'Your selection has been recorded',
            );
        } catch (error) {
            return forwardSelectionError(error, next);
        }
    }

    /**
     * POST /api/v1/proposals/:id/selection
     *
     * Staff recording a choice the customer made off-platform — by phone or in
     * a reply. Authenticated, and the staff member is recorded as the source so
     * the acceptance is attributable to a person.
     */
    async recordForCustomer(req: Request, res: Response, next: NextFunction) {
        try {
            const proposalId = req.params['id'] as string;
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;

            const selection = await optionSelectionService.selectOption({
                proposalId,
                hotelCode: body.hotelCode,
                acceptTerms: body.acceptTerms,
                selectedByEmail: body.selectedByEmail,
                selectedById: userId,
                acceptedFromIp: req.ip,
                acceptedUserAgent: req.get('user-agent'),
            });

            return sendResponse(res, 201, selection, 'Selection recorded');
        } catch (error) {
            return forwardSelectionError(error, next);
        }
    }

    /** GET /api/v1/proposals/:id/selection — what the customer chose. */
    async getForProposal(req: Request, res: Response, next: NextFunction) {
        try {
            const proposalId = req.params['id'] as string;
            const selection = await optionSelectionService.findByProposal(proposalId);

            if (!selection) {
                return sendResponse(res, 404, null, 'No option has been selected yet', 'NOT_FOUND');
            }

            return sendResponse(
                res,
                200,
                {
                    ...selection,
                    priceLockValid: optionSelectionService.isPriceLockValid(selection),
                },
                'Selection retrieved',
            );
        } catch (error) {
            return forwardSelectionError(error, next);
        }
    }

    /**
     * POST /api/v1/selections/:id/book
     *
     * Run the client's sequence for a recorded selection: raise the Odoo sales
     * order, check availability, book the rooms, and write the reservation
     * references back.
     *
     * Answers 200 with warnings rather than an error when only part of it
     * completed. A group that holds rooms but has no sales order, or holds most
     * of its rooms, is a real state that someone has to finish — reporting it as
     * a failure would hide what did succeed.
     */
    async bookSelection(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await selectionToBookingService.processSelection(
                req.params['id'] as string,
            );

            const complete =
                result.warnings.length === 0 &&
                result.roomsConfirmed >= result.roomsRequested;

            return sendResponse(
                res,
                complete ? 201 : 207,
                result,
                complete
                    ? `Booked — ${result.roomsConfirmed} room(s) held, order ${result.odooOrderName}`
                    : `Partially completed. ${result.warnings.join(' ')}`,
            );
        } catch (error) {
            return forwardSelectionError(error, next);
        }
    }

    /**
     * DELETE /api/v1/selections/:id
     *
     * Withdraw a selection so a different option can be chosen. Refused once a
     * booking exists — at that point rooms are held with a supplier and the
     * booking has to be cancelled rather than the record deleted.
     */
    async withdraw(req: Request, res: Response, next: NextFunction) {
        try {
            await optionSelectionService.withdrawSelection(req.params['id'] as string);
            return sendResponse(res, 200, null, 'Selection withdrawn');
        } catch (error) {
            return forwardSelectionError(error, next);
        }
    }
}

export default new OptionSelectionController();
