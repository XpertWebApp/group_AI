import { z } from 'zod';
import { MAX_ROOMS_PER_SEARCH } from '../services/certificationSearch.service';

/**
 * Request schemas for the WBE booking flow.
 *
 * These enforce WBE's payload rules at the edge, before a booking row exists
 * and before any WBE call is made. That ordering matters: several of these
 * rules (passenger counts, the Age/Salutation split) are only rejected by WBE
 * *after* the single permitted prebook has been consumed, which would waste a
 * certification scenario and require restarting the flow.
 */

/** WBE's accepted passenger titles. `Chd` is reserved for children. */
const ADULT_SALUTATIONS = ['Mr', 'Ms', 'Mrs', 'Miss'] as const;
const CHILD_SALUTATION = 'Chd';

const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .refine((d) => !Number.isNaN(Date.parse(d)), { message: 'Invalid date' });

/**
 * A passenger. The Age rule is WBE's, not ours: the attribute must carry the
 * child's age and must be *absent* for adults — sending `Age: 0` for an adult
 * is a rejection, so the two cases are validated separately rather than
 * defaulting age to zero.
 */
export const BookingPassengerSchema = z
    .object({
        salutation: z.enum([...ADULT_SALUTATIONS, CHILD_SALUTATION]),
        firstName: z.string().trim().min(1, 'firstName is required').max(100),
        lastName: z.string().trim().min(1, 'lastName is required').max(100),
        isChild: z.boolean(),
        age: z.number().int().min(0).max(17).optional(),
        isLeader: z.boolean().optional().default(false),
    })
    .superRefine((p, ctx) => {
        if (p.isChild) {
            if (p.age === undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['age'],
                    message: 'age is required for child passengers',
                });
            }
            if (p.salutation !== CHILD_SALUTATION) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['salutation'],
                    message: `salutation must be "${CHILD_SALUTATION}" for child passengers`,
                });
            }
            return;
        }

        if (p.age !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['age'],
                message: 'age must be omitted for adult passengers — WBE rejects Age on an adult',
            });
        }
        if (!ADULT_SALUTATIONS.includes(p.salutation as (typeof ADULT_SALUTATIONS)[number])) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['salutation'],
                message: `salutation must be one of ${ADULT_SALUTATIONS.join(', ')} for adult passengers`,
            });
        }
    });

/**
 * A room plus its passenger manifest. The declared occupancy must match the
 * passengers supplied — WBE books against the occupancy the option was
 * searched with, so a mismatch produces a rejected booking rather than a
 * partially filled room.
 */
export const BookingRoomSchema = z
    .object({
        roomId: z.number().int().min(1, 'roomId is 1-based and must match the search request'),
        adultsNo: z.number().int().min(1),
        childrenNo: z.number().int().min(0),
        roomDescription: z.string().trim().max(500).optional(),
        mealType: z.string().trim().max(10).optional(),
        mealName: z.string().trim().max(255).optional(),
        price: z.number().nonnegative().optional(),
        /** SupplementId values taken from the OptionDetailsV2 response. */
        optionalExtras: z.array(z.number().int()).optional(),
        passengers: z.array(BookingPassengerSchema).min(1, 'At least one passenger is required'),
    })
    .superRefine((room, ctx) => {
        const adults = room.passengers.filter((p) => !p.isChild).length;
        const children = room.passengers.filter((p) => p.isChild).length;

        if (adults !== room.adultsNo) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['passengers'],
                message: `Room ${room.roomId}: expected ${room.adultsNo} adult passenger(s), got ${adults}`,
            });
        }
        if (children !== room.childrenNo) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['passengers'],
                message: `Room ${room.roomId}: expected ${room.childrenNo} child passenger(s), got ${children}`,
            });
        }
    });

/** POST /api/v1/bookings — persist a chosen option as a draft booking. */
export const SelectOptionSchema = z
    .object({
        /** From the search response; required by OptionDetailsV2 and BookV2. */
        sessionId: z.string().trim().min(1, 'sessionId is required'),
        tid: z.string().trim().min(1, 'tid is required'),
        hotelCode: z.string().trim().min(1, 'hotelCode is required'),
        hotelName: z.string().trim().max(255).optional(),
        destinationId: z.number().int().optional(),
        destinationName: z.string().trim().max(255).optional(),

        checkInDate: isoDate,
        checkOutDate: isoDate,
        nights: z.number().int().min(1),

        /** Price shown to the user from OptionDetailsV2 with Prebook=false. */
        quotedPrice: z.number().nonnegative().optional(),
        currency: z.string().trim().max(10).optional(),

        // WBE caps HotelNotes at 250 characters and rejects special characters,
        // permitting only letters, digits, dot, comma and space.
        hotelNotes: z
            .string()
            .trim()
            .max(250)
            .regex(/^[\p{L}\p{N}., ]*$/u, 'hotelNotes may contain only letters, numbers, dots, commas and spaces')
            .optional(),
        carbonCopyMail: z.string().trim().email().max(255).optional(),

        /**
         * Whether to ask WBE to voucher during BookV2. Defaults to false: SETT
         * issues vouchers through the separate IssueVoucher call, which is the
         * answer given in the certification questionnaire.
         */
        issueVoucherOnBook: z.boolean().optional().default(false),

        requestId: z.string().uuid().optional(),

        /** Certification runs are flagged so they stay out of business reporting. */
        isCertificationTest: z.boolean().optional().default(false),
        certificationScenario: z.number().int().min(1).max(14).optional(),

        rooms: z
            .array(BookingRoomSchema)
            .min(1, 'At least one room is required')
            .max(MAX_ROOMS_PER_SEARCH, `WBE allows a maximum of ${MAX_ROOMS_PER_SEARCH} rooms per booking`),
    })
    .superRefine((body, ctx) => {
        if (Date.parse(body.checkOutDate) <= Date.parse(body.checkInDate)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['checkOutDate'],
                message: 'checkOutDate must be after checkInDate',
            });
        }

        // Nights must agree with the dates, otherwise the booking is priced
        // for a different stay than the one requested.
        const derivedNights = Math.round(
            (Date.parse(body.checkOutDate) - Date.parse(body.checkInDate)) / 86_400_000,
        );
        if (derivedNights !== body.nights) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['nights'],
                message: `nights (${body.nights}) does not match the date range (${derivedNights} night(s))`,
            });
        }

        // RoomIds address rooms in the WBE payload, so they must be unique.
        const roomIds = body.rooms.map((r) => r.roomId);
        if (new Set(roomIds).size !== roomIds.length) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['rooms'],
                message: 'roomId values must be unique across rooms',
            });
        }

        const leaders = body.rooms.flatMap((r) => r.passengers).filter((p) => p.isLeader);
        if (leaders.length > 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['rooms'],
                message: `Only one passenger may be marked as leader; got ${leaders.length}`,
            });
        }
    });

/** One room's occupancy for a certification search. */
export const CertificationSearchRoomSchema = z.object({
    adults: z.number().int().min(1, 'Each room needs at least one adult'),
    /** One age per child; the child count is derived from this array. */
    childrenAges: z.array(z.number().int().min(0).max(17)).optional().default([]),
});

/** POST /api/v1/bookings/certification/search — raw WBE availability search. */
export const CertificationSearchSchema = z
    .object({
        hotelCodes: z.array(z.string().trim().min(1)).max(100).optional(),
        destinationId: z.number().int().optional(),
        starRatings: z.array(z.number().min(1).max(6)).optional(),
        hotelLimit: z.number().int().min(1).max(100).optional(),

        checkInDate: isoDate,
        nights: z.number().int().min(1).max(30),
        rooms: z
            .array(CertificationSearchRoomSchema)
            .min(1, 'At least one room is required')
            .max(MAX_ROOMS_PER_SEARCH, `WBE allows a maximum of ${MAX_ROOMS_PER_SEARCH} rooms per search`),

        currencyCode: z.string().trim().length(3).optional(),
        nationalityCode: z.string().trim().min(2).max(3).optional(),
        mealType: z.string().trim().max(10).optional(),
        waitSeconds: z.number().int().min(1).max(60).optional(),
    })
    .superRefine((body, ctx) => {
        if (!body.hotelCodes?.length && body.destinationId === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['hotelCodes'],
                message: 'Provide either hotelCodes or a destinationId to search',
            });
        }
    });

/** GET /api/v1/bookings — listing filters. */
export const ListBookingsSchema = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    status: z
        .enum([
            'draft',
            'prebooked',
            'price_changed',
            'booking',
            'booked',
            'vouchered',
            'cancelled',
            'pending_cancellation',
            'failed',
        ])
        .optional(),
    requestId: z.string().uuid().optional(),
    includeCertificationTests: z.coerce.boolean().optional().default(false),
});

/** Path parameter shared by every per-booking route. */
export const BookingIdParamSchema = z.object({
    id: z.string().uuid('booking id must be a UUID'),
});

export type SelectOptionInput = z.infer<typeof SelectOptionSchema>;
export type CertificationSearchInput = z.infer<typeof CertificationSearchSchema>;
export type ListBookingsInput = z.infer<typeof ListBookingsSchema>;
