import { z } from 'zod';

import { BookingRoomSchema } from './bookingSchemas';

/**
 * Request validation for group bookings.
 *
 * A group booking creates several real reservations from one call, so these
 * schemas are the last point at which a malformed request costs nothing. The
 * occupancy rules are inherited from BookingRoomSchema rather than restated,
 * so passenger validation cannot drift between a single booking and a group.
 */

/**
 * POST /api/v1/booking-groups — book a hotel for a whole group.
 *
 * The caller supplies what the customer was promised; the service re-searches
 * for current availability and splits the rooms across suppliers itself. No
 * TID or session is accepted here on purpose: whatever the caller holds is
 * from the proposal and will usually have expired.
 */
export const CreateBookingGroupSchema = z
    .object({
        requestId: z.string().uuid('requestId must be a UUID'),

        /** The accepted proposal, when the booking came from one. */
        proposalId: z.string().uuid('proposalId must be a UUID').optional(),

        hotelCode: z.string().trim().min(1, 'hotelCode is required').max(255),
        hotelName: z.string().trim().max(255).optional(),

        checkInDate: z.coerce.date(),
        nights: z.number().int().min(1, 'nights must be at least 1').max(60),

        /**
         * Rooms the customer is owed. Checked against the manifest below, since
         * a mismatch here means booking a different group from the one quoted.
         */
        roomsRequested: z.number().int().min(1).max(100),

        /** Price the customer accepted, used to detect drift at booking time. */
        quotedTotal: z.number().nonnegative().optional(),
        currency: z.string().trim().length(3).optional(),

        /** Passenger manifest, one entry per room. */
        rooms: z.array(BookingRoomSchema).min(1, 'At least one room is required'),

        carbonCopyMail: z.string().email('carbonCopyMail must be an email').optional(),

        /**
         * Book even when the supplier price has moved beyond tolerance.
         *
         * An explicit operator decision, never a default: the whole point of
         * the tolerance is that someone looks before the customer is charged
         * more than they agreed to.
         */
        acceptPriceDrift: z.boolean().optional().default(false),
    })
    .superRefine((body, ctx) => {
        if (body.rooms.length !== body.roomsRequested) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['rooms'],
                message:
                    `roomsRequested is ${body.roomsRequested} but ${body.rooms.length} room(s) ` +
                    `were supplied; the manifest must cover every room being booked`,
            });
        }
    });

/** GET /api/v1/booking-groups — paginated list for the staff dashboard. */
export const ListBookingGroupsSchema = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    status: z
        .enum(['pending', 'booking', 'confirmed', 'partial', 'failed', 'cancelled'])
        .optional(),
    requestId: z.string().uuid().optional(),
});

/** Path parameter shared by every per-group route. */
export const BookingGroupIdParamSchema = z.object({
    id: z.string().uuid('booking group id must be a UUID'),
});

/**
 * POST /api/v1/booking-groups/:id/review/approve
 *
 * Notes are optional: a clean booking needs no commentary, and requiring one
 * would produce a column full of "ok".
 */
export const ApproveReviewSchema = z.object({
    notes: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/v1/booking-groups/:id/review/reject
 *
 * The reason is required. A rejection with no explanation leaves whoever picks
 * the group up next with nothing to act on, and this is the record of why a
 * customer was not sent an offer.
 */
export const RejectReviewSchema = z.object({
    reason: z
        .string()
        .trim()
        .min(10, 'Give a reason a colleague can act on — at least a sentence')
        .max(2000),
});

export type CreateBookingGroupInput = z.infer<typeof CreateBookingGroupSchema>;
export type ListBookingGroupsInput = z.infer<typeof ListBookingGroupsSchema>;
