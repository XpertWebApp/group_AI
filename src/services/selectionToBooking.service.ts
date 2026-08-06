import { PrismaClient } from '@prisma/client';

import optionSelectionService from './optionSelection.service';
import odooSalesOrderService, { OdooSalesOrderError } from './odooSalesOrder.service';
import * as cfg from '../config/odooSalesOrder';
import groupBookingService, { GroupBookingError } from './groupBooking.service';
import {
    buildPassengerManifest,
    roomsFromBreakdown,
} from './passengerManifest.service';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * Runs the client's booking sequence once a customer has chosen an option.
 *
 * The order of the steps is theirs, not ours:
 *
 *   customer selects → Odoo sales order under LTD → availability checked
 *   → booked in SETT Hub as a multi-service booking → reservation numbers
 *   written back to Odoo → group handler reviews
 *
 * The sales order comes first deliberately. It is the commercial record, and
 * raising it before any supplier is contacted means a booking can never exist
 * without something in Odoo to account for it. The reverse — reserving rooms
 * and failing to record them — is the case that costs money quietly.
 *
 * Each step is allowed to fail without unwinding the one before it. A booking
 * that succeeded is not cancelled because Odoo was unreachable, and an order
 * that was raised is not deleted because a supplier refused: both are real
 * records of something that happened, and an operator resolves the mismatch.
 */

export interface BookSelectionResult {
    selectionId: string;
    /** Null when Odoo could not be written to; the booking still went ahead. */
    odooOrderId: number | null;
    odooOrderName: string | null;
    /** Null when no rooms could be held. */
    bookingGroupId: string | null;
    groupReference: string | null;
    roomsConfirmed: number;
    roomsRequested: number;
    /** Steps that did not complete, for the operator to finish by hand. */
    warnings: string[];
}

export class SelectionToBookingService {
    /**
     * Take a recorded selection through to held rooms and a sales order.
     *
     * Returns a result rather than throwing on partial completion: a group that
     * booked most of its rooms, or booked them without an Odoo order, is a real
     * outcome that has to be reported and worked on — not an exception to
     * unwind.
     */
    async processSelection(selectionId: string): Promise<BookSelectionResult> {
        const warnings: string[] = [];

        const selection = await prisma.optionSelection.findUnique({
            where: { id: selectionId },
            include: {
                proposal: {
                    include: {
                        hotels: { where: { deletedAt: null } },
                        bookingRequest: true,
                    },
                },
            },
        });

        if (!selection) {
            throw new GroupBookingError('Selection not found', 'PROPOSAL_NOT_BOOKABLE');
        }

        const request = selection.proposal.bookingRequest;
        if (!request) {
            throw new GroupBookingError(
                'This proposal is not linked to a request, so there is nothing to book',
                'PROPOSAL_NOT_BOOKABLE',
            );
        }

        const hotel = selection.proposal.hotels.find(
            (h) => h.hotelCode === selection.hotelCode,
        );
        if (!hotel) {
            throw new GroupBookingError(
                'The selected hotel is no longer on this proposal',
                'PROPOSAL_NOT_BOOKABLE',
            );
        }

        // Expand the quoted room mix into individual rooms, then fill them with
        // placeholder guests. Real names are not available at this point and are
        // not expected to be — the rooming list arrives closer to travel.
        const occupancy = roomsFromBreakdown((request.rooms ?? {}) as Record<string, number>);
        const [leadFirst, ...leadRest] = (request.contactName ?? '').trim().split(/\s+/);
        const manifest = buildPassengerManifest(occupancy, {
            leadFirstName: leadFirst || undefined,
            leadLastName: leadRest.join(' ') || undefined,
            // Seeded on the request so a retry books the same names rather than
            // looking like a second, different group to the supplier.
            seed: `request-${request.id}`,
        });

        logger.info({
            msg: 'Processing selection into a booking',
            selectionId,
            requestReference: request.referenceNumber,
            hotelCode: selection.hotelCode,
            rooms: occupancy.length,
            nonRefundable: selection.nonRefundable,
        });

        // ── 1. Sales order, before any supplier is contacted ─────────────────
        let odooOrderId: number | null = null;
        let odooOrderName: string | null = null;

        try {
            const order = await odooSalesOrderService.createGroupSalesOrder({
                customerPartnerId: request.odooContactId ?? 0,
                requestReference: request.referenceNumber,
                groupName: request.companyName ?? undefined,
                groupSize: request.groupSize ?? occupancy.length,
                groupType: request.groupType ?? undefined,
                destinationName: request.destinationName ?? undefined,
                hotelName: hotel.hotelName ?? undefined,
                hotelAddress: hotel.address ?? undefined,
                hotelCategory: hotel.starRating ? `${hotel.starRating}*` : undefined,
                checkInDate: request.checkinDate,
                checkOutDate: request.checkoutDate ?? this.addNights(request.checkinDate, request.nights),
                nights: request.nights,
                roomBreakdown: (request.rooms ?? undefined) as Record<string, number> | undefined,
                roomsTotal: occupancy.length,
                mealPlan: request.breakfastPreference ?? undefined,
                buyingTotal: hotel.totalPrice ? Number(hotel.totalPrice) : undefined,
                sellingTotal: Number(selection.acceptedTotal ?? hotel.totalPrice ?? 0),
                currency: selection.currency ?? hotel.currency,
                cancellationConditions: this.termsField(selection.acceptedTerms, 'cancellationPolicy'),
                paymentConditions: this.termsField(selection.acceptedTerms, 'paymentTerms'),
                nonRefundable: selection.nonRefundable,
            });

            odooOrderId = order.orderId;
            odooOrderName = order.orderName;
        } catch (err: any) {
            const reason =
                err instanceof OdooSalesOrderError
                    ? `${err.code}: ${err.message}`
                    : err.message;

            // Not fatal. The customer has chosen and expects rooms; refusing to
            // book because an accounting record failed would be the wrong way
            // round. The gap is reported instead.
            warnings.push(`Odoo sales order was not created (${reason}). Raise it manually.`);
            logger.error({ msg: 'Odoo sales order failed', selectionId, error: err.message });
        }

        // ── 2. Availability and the booking itself ───────────────────────────
        let group = null;
        try {
            group = await groupBookingService.bookGroup({
                requestId: request.id,
                proposalId: selection.proposalId,
                hotelCode: selection.hotelCode,
                hotelName: selection.hotelName ?? undefined,
                checkInDate: request.checkinDate,
                nights: request.nights,
                roomsRequested: occupancy.length,
                quotedTotal: selection.acceptedTotal ? Number(selection.acceptedTotal) : undefined,
                currency: selection.currency ?? undefined,
                rooms: manifest,
            });
        } catch (err: any) {
            const reason = err instanceof GroupBookingError ? `${err.code}: ${err.message}` : err.message;
            warnings.push(`No rooms were booked (${reason}).`);
            logger.error({ msg: 'Group booking failed', selectionId, error: err.message });

            return {
                selectionId,
                odooOrderId,
                odooOrderName,
                bookingGroupId: null,
                groupReference: null,
                roomsConfirmed: 0,
                roomsRequested: occupancy.length,
                warnings,
            };
        }

        // ── 3. Record which order this booking belongs to ────────────────────
        // Written as soon as both exist. Without it the reference is lost with
        // the response, leaving no way back to the commercial record for a
        // later stage update, a support query, or reconciliation.
        if (odooOrderId) {
            // Move the order to the stage that matches reality: rooms are held,
            // the customer has not yet formally confirmed. Only when something
            // was actually booked — an order with no rooms behind it has not
            // reached that stage.
            const stage =
                group.roomsConfirmed > 0
                    ? await odooSalesOrderService.moveToStage(odooOrderId, cfg.BOOKED_STAGE_NAME)
                    : null;

            await prisma.bookingGroup
                .update({
                    where: { id: group.id },
                    data: {
                        odooOrderId,
                        odooOrderName,
                        odooStage: stage,
                        odooSyncedAt: new Date(),
                    },
                })
                .catch((err: any) => {
                    // A link that fails to save does not undo a booking that
                    // succeeded; it is reported so an operator can restore it.
                    warnings.push(
                        `Booking is not linked to Odoo order ${odooOrderName} (${err.message}).`,
                    );
                });
        }

        // ── 4. Reservation references back to Odoo ───────────────────────────
        if (odooOrderId) {
            const references = group.bookings
                .map((b) => b.bookingReference)
                .filter((r): r is string => Boolean(r));

            if (references.length > 0) {
                try {
                    await odooSalesOrderService.attachReservations(odooOrderId, {
                        reservationNumbers: references,
                        hotelName: selection.hotelName ?? undefined,
                    });
                } catch (err: any) {
                    // The reservations exist at the supplier whether or not Odoo
                    // records them, so this is a bookkeeping gap rather than a
                    // booking failure.
                    warnings.push(
                        `Booking references were not written to Odoo (${err.message}). ` +
                            `Add them to order ${odooOrderName} manually: ${references.join(', ')}`,
                    );
                }
            }
        }

        if (group.roomsConfirmed < group.roomsRequested) {
            warnings.push(
                `Only ${group.roomsConfirmed} of ${group.roomsRequested} rooms were confirmed. ` +
                    `${group.shortfallNote ?? ''}`.trim(),
            );
        }

        logger.info({
            msg: 'Selection processed',
            selectionId,
            odooOrderName,
            groupReference: group.groupReference,
            rooms: `${group.roomsConfirmed}/${group.roomsRequested}`,
            warnings: warnings.length,
        });

        return {
            selectionId,
            odooOrderId,
            odooOrderName,
            bookingGroupId: group.id,
            groupReference: group.groupReference,
            roomsConfirmed: group.roomsConfirmed,
            roomsRequested: group.roomsRequested,
            warnings,
        };
    }

    /** Read one field out of the snapshotted terms, which are stored as JSON. */
    private termsField(terms: unknown, key: string): string | undefined {
        if (!terms || typeof terms !== 'object') return undefined;
        const value = (terms as Record<string, unknown>)[key];
        return typeof value === 'string' ? value : undefined;
    }

    private addNights(from: Date, nights: number): Date {
        return new Date(from.getTime() + nights * 86_400_000);
    }
}

export default new SelectionToBookingService();
