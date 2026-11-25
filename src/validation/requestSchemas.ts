import { z } from 'zod';
import { parseGroupType } from '../services/webhook.service';

// ── Rooms (Step 2 - Room & Accommodations) ─────────────────────────────────
export const RoomsSchema = z.object({
    single: z.number().int().min(0).default(0),
    double: z.number().int().min(0).default(0),
    twin: z.number().int().min(0).default(0),
    triple: z.number().int().min(0).default(0),
    quadruple: z.number().int().min(0).default(0),
    suites: z.number().int().min(0).default(0),
    standardDoubleBeds: z.number().int().min(0).default(0),
    twinBeds: z.number().int().min(0).default(0),
    extraRoomsNote: z.string().trim().max(2000).nullable().optional(),
});

const dateString = (label: string) =>
    z.string().refine((d) => !isNaN(Date.parse(d)), { message: `Invalid ${label}` });

/**
 * Single half-step star value (1, 1.5, …, 5.5, 6).
 * Used both for the legacy single `starRating` field and as the element
 * type for the new multi-select `starRatings` array.
 */
const SingleStarRatingSchema = z
    .number()
    .min(1)
    .max(6)
    .refine((v) => v * 2 === Math.round(v * 2), {
        message: 'Star rating must be in 0.5 increments (e.g. 1, 1.5, 2, ... 5.5, 6)',
    });

/**
 * Multi-select star categories — one entry per ticked box on the
 * Create Request form. Validates 1-6 categories, each a valid
 * half-step value, with no duplicates. An empty array is rejected
 * (use `undefined` instead to mean "any star").
 */
const StarRatingsArraySchema = z
    .array(SingleStarRatingSchema)
    .min(1, 'Pick at least one star category')
    .max(6, 'Cannot select more than 6 star categories')
    .refine((arr) => new Set(arr).size === arr.length, {
        message: 'Duplicate star categories are not allowed',
    });

// ── BookingRequest (4-step Create Request form) ────────────────────────────
export const CreateBookingRequestSchema = z
    .object({
        // Step 1: Trip Details
        destinationId: z.number().int(),
        destinationName: z.string().min(1),
        checkinDate: dateString('check-in date'),
        checkoutDate: dateString('check-out date').optional(),
        /** nights is derived from checkinDate + checkoutDate, but can be supplied directly */
        nights: z.number().int().min(1).optional(),
        // Legacy single-value star rating. Wix webhook + older frontend builds
        // still send this. Kept for back-compat; new multi-select frontends
        // should send `starRatings` instead. The service layer reads
        // `starRatings` first and falls back to `[starRating]`.
        starRating: SingleStarRatingSchema.optional(),
        /** Multi-select star categories. 1-6 entries, no duplicates. */
        starRatings: StarRatingsArraySchema.optional(),
        budgetRange: z.string().max(100).optional(),
        budget: z.number().positive().optional(),
        groupType: z.string().max(100).optional(),
        groupSize: z.number().int().min(1).optional(),
        averageAge: z.number().int().min(6).max(25).optional(),
        currencyCode: z.string().min(2).max(10).optional(),
        // REQUIRED as of 2026-06-26 — eliminates the silent 'HU' default
        // that was previously being sent to WBE when staff didn't pick
        // a nationality. The FE Create Request form must surface a
        // dropdown sourced from GET /api/v1/nationalities. Webhook
        // payloads (Wix, WordPress) that don't carry a nationality fall
        // through to the legacy 'HU' fallback in hotelSearch.service.ts
        // — only for rows created before the cutoff date.
        nationalityCode: z.string().min(1).max(10),

        // Step 2: Room & Accommodations
        rooms: RoomsSchema.optional(),
        breakfastPreference: z.enum(['BB', 'RO']).optional(),
        hotelLocation: z.enum(['central', 'outside_city_center']).optional(),
        specialRequirements: z.string().max(5000).nullable().optional(),

        // Step 3: Customer Details
        companyName: z.string().min(1),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        contactName: z.string().optional(),
        contactEmail: z.string().email(),
        contactPhone: z.string().min(5),
        contactPhoneCountryCode: z.string()
            .regex(/^\+\d{1,5}$/, 'Country code must start with + followed by 1-5 digits')
            .max(8)
            .optional()
            .nullable(),
        guestListFileKey: z.string().optional(),
        customerNotes: z.string().max(5000).nullable().optional(),
        // Odoo CRM link. Optional at request creation (free-text companyName
        // still works), but offer-send is blocked until this is set on
        // requests created after the Odoo-gate cutover. See proposals.service.
        odooContactId: z.number().int().positive().nullable().optional(),

        // Step 4: Policies
        termsAndConditions: z.string().optional(),
        cancellationConditions: z.string().optional(),

        // System
        source: z.string().optional(),
        status: z.enum(['pending', 'draft']).optional(),
    })
    .refine(
        (d) => {
            // Must have nights or checkoutDate to determine stay length
            if (!d.nights && !d.checkoutDate) return false;
            if (d.checkoutDate) {
                const diff =
                    (new Date(d.checkoutDate).getTime() - new Date(d.checkinDate).getTime()) /
                    86_400_000;
                return diff >= 1;
            }
            return true;
        },
        { message: 'Either nights or checkoutDate must be provided and checkout must be after checkin' },
    )
    .refine(
        (d) => {
            if (!d.groupType) return true;
            const code = parseGroupType(d.groupType);
            const ageRequired = code === 'youth' || code === 'school';
            return !ageRequired || typeof d.averageAge === 'number';
        },
        { message: 'averageAge is required when groupType is Youth Group or School Group', path: ['averageAge'] },
    );

export const UpdateBookingRequestSchema = z.object({
    // Step 1
    destinationId: z.number().int().optional(),
    destinationName: z.string().min(1).optional(),
    checkinDate: dateString('check-in date').optional(),
    checkoutDate: dateString('check-out date').optional(),
    nights: z.number().int().min(1).optional(),
    // Legacy single-value field, kept for back-compat with Wix + older FE.
    starRating: SingleStarRatingSchema.optional(),
    /** Multi-select star categories. 1-6 entries, no duplicates. */
    starRatings: StarRatingsArraySchema.optional(),
    budgetRange: z.string().max(100).optional(),
    budget: z.number().positive().optional(),
    groupType: z.string().max(100).optional(),
    groupSize: z.number().int().min(1).optional(),
    averageAge: z.number().int().min(6).max(25).nullable().optional(),
    currencyCode: z.string().min(2).max(10).optional(),
    nationalityCode: z.string().min(1).max(10).optional(),
    // Step 2
    rooms: RoomsSchema.optional(),
    breakfastPreference: z.enum(['BB', 'RO']).optional(),
    hotelLocation: z.enum(['central', 'outside_city_center']).optional(),
    specialRequirements: z.string().max(5000).nullable().optional(),
    // Step 3
    companyName: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    contactName: z.string().optional(),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().min(5).optional(),
    contactPhoneCountryCode: z.string()
        .regex(/^\+\d{1,5}$/, 'Country code must start with + followed by 1-5 digits')
        .max(8)
        .optional()
        .nullable(),
    guestListFileKey: z.string().optional(),
    customerNotes: z.string().max(5000).nullable().optional(),
    // Odoo CRM link — staff sets/clears this from the company autocomplete.
    odooContactId: z.number().int().positive().nullable().optional(),
    // Step 4
    termsAndConditions: z.string().optional(),
    cancellationConditions: z.string().optional(),
    // System
    source: z.string().optional(),
    status: z.enum(['pending', 'draft', 'processing', 'ai_generated', 'completed', 'cancelled', 'sent', 'declined', 'needs_manual_handling']).optional(),
}).superRefine((d, ctx) => {
    if (d.groupType === undefined) return;
    const code = parseGroupType(d.groupType ?? '');
    const ageRequired = code === 'youth' || code === 'school';
    if (ageRequired && (d.averageAge === undefined || d.averageAge === null)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['averageAge'],
            message: 'averageAge is required when groupType is Youth Group or School Group',
        });
    }
});

// ── Group Requests list (pagination + search + filter) ─────────────────────
export const ListRequestsQuerySchema = z.object({
    page: z.string().optional().transform((v) => (v ? parseInt(v, 10) : 1)),
    limit: z.string().optional().transform((v) => (v ? Math.min(parseInt(v, 10), 100) : 20)),
    search: z.string().optional(),
    status: z
        .enum(['pending', 'draft', 'processing', 'ai_generated', 'completed', 'cancelled', 'sent', 'declined', 'needs_manual_handling', ''])
        .optional()
        .transform((v) => v || undefined),
    // Legacy params — applied to `checkinDate`. Kept for back-compat with
    // older FE callers; new code should use createdFrom/createdTo below.
    dateFrom: z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid dateFrom' }),
    dateTo: z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid dateTo' }),
    // New explicit window on `createdAt` — drives the dashboard's
    // "This Month / Quarter / Year" filter chip. ISO timestamps.
    createdFrom: z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid createdFrom' }),
    createdTo: z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid createdTo' }),
    sortBy: z.enum(['createdAt', 'checkinDate', 'referenceNumber']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

// ── Odoo company autocomplete ─────────────────────────────────────────────
// Powers GET /api/v1/odoo/customers/search. Limit is capped at 20 in the
// controller too — duplicated here so a malformed FE call fails fast at
// validation rather than firing a wasted Odoo round-trip.
export const OdooSearchQuerySchema = z.object({
    q: z.string().min(2, 'Type at least 2 characters').max(100),
    limit: z
        .string()
        .optional()
        .transform((v) => (v ? Math.min(Math.max(parseInt(v, 10) || 20, 1), 20) : 20)),
});

// ── Proposal ───────────────────────────────────────────────────────────────
// Zod v4: z.record requires (keyType, valueType) — use z.string() as key type
export const CreateProposalSchema = z.object({
    notes: z.string().max(5000).optional(),
    markupSettings: z.record(z.string(), z.any()).optional(),
});

export const UpdateProposalSchema = CreateProposalSchema.partial();

// ── ProposalHotel ──────────────────────────────────────────────────────────
const RoomDetailSchema = z.object({
    net: z.number().nonnegative(),
    sell: z.number().nonnegative(),
    qty: z.number().int().nonnegative(),
    nights: z.number().int().nonnegative(),
    /**
     * Maximum quantity the supplier(s) can actually deliver for this
     * room type at this hotel. Populated by the BE at add-hotel time
     * from the search response's supplierSplit[]. Used by the FE
     * qty-stepper to cap increments. Optional so legacy proposals
     * without the field still work.
     */
    maxQty: z.number().int().nonnegative().optional(),
    /**
     * Per-supplier breakdown for this room type. Same source and
     * purpose as maxQty. Optional; empty array or missing = FE falls
     * back to hotel-level supplierCode.
     */
    supplierBreakdown: z
        .array(z.object({
            supplierCode: z.string().min(1).max(50),
            rooms: z.number().int().nonnegative(),
        }))
        .optional(),
});

export const AddProposalHotelSchema = z.object({
    hotelCode: z.string().min(1),
    hotelName: z.string().max(500).optional(),
    tid: z.string().optional(),
    rooms: z.record(z.string(), RoomDetailSchema).optional(),
    /**
     * Per-type supplier breakdown from the hotel-search response. When
     * present, the BE enriches `rooms.<type>.supplierBreakdown` and
     * `rooms.<type>.maxQty` before saving — used by the FE's qty-stepper
     * hint ("HBA 4 · EANRP 2 · max 6") and by the manual room-split
     * feature to cap increments at supplier-verified availability.
     *
     * Each entry represents one supplier fulfilling one room type at
     * this hotel. The FE sources it from `HotelResult.supplierSplit[]`
     * — see hotelSearch.service.ts SupplierSplit interface.
     *
     * Optional and additive: legacy FE callers that don't send this
     * still work (the rooms JSON just won't have the enrichment
     * fields, and the FE falls back to the hotel-level supplierCode).
     */
    supplierSplit: z
        .array(z.object({
            supplierCode: z.string().min(1).max(50),
            tid: z.string().optional(),
            rooms: z.number().int().nonnegative(),
            roomType: z.string().min(1).max(40),
            pricePerRoomPerNight: z.number().nonnegative().optional(),
            sellPricePerRoomPerNight: z.number().nonnegative().optional(),
            currency: z.string().min(2).max(10).optional(),
        }))
        .optional(),
    currency: z.string().min(2).max(10),
    totalPrice: z.number().nonnegative(),
    freeCancellation: z.boolean().optional(),
    cancelDeadline: z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    supplierCode: z.string().optional(),
    optionDetailsId: z.string().uuid().optional(),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    starRating: z.number().int().min(1).max(5).optional().nullable(),
    address: z.string().max(2000).optional().nullable(),
    addressCity: z.string().max(255).optional().nullable(),
    addressCountry: z.string().max(10).optional().nullable(),
    /**
     * Optional public SETTHub deep-link URL. The dashboard uses this to
     * make the hotel name on the Request Summary page clickable. We
     * accept a plain URL string here and let the FE source it from the
     * Add Hotel card (which already has it on each hotel object from
     * the hotel-search response). If null/missing, the repository
     * derives it from `masterHotelId` when persisting.
     */
    sethubDetailsUrl: z.string().url().max(2000).optional().nullable(),
});

export const AdjustHotelPricingSchema = z.object({
    // Per-room-type patch. Every field is optional so the FE can send a
    // minimal partial update (e.g. `{ qty: 3 }` from the qty stepper) and
    // the repo merge preserves whatever isn't in the patch.
    //
    // `maxQty` and `supplierBreakdown` are ALSO accepted so an FE echoing
    // the full rooms map on save doesn't silently lose those fields
    // (Zod strips unknown keys by default). Persisted values still
    // originate from the search response at add-hotel time — the FE
    // should not normally alter them on edit. Explicit accept here just
    // means the round-trip is honest instead of silently-dropped.
    rooms: z.record(z.string(), z.object({
        net: z.number().nonnegative().optional(),
        sell: z.number().nonnegative().optional(),
        qty: z.number().int().nonnegative().optional(),
        nights: z.number().int().nonnegative().optional(),
        maxQty: z.number().int().nonnegative().optional(),
        supplierBreakdown: z
            .array(z.object({
                supplierCode: z.string().min(1).max(50),
                rooms: z.number().int().nonnegative(),
            }))
            .optional(),
    })).optional(),
    totalPrice: z.number().nonnegative().optional(),
    currency: z.string().min(2).max(10).optional(),
});

// ── ProposalService ────────────────────────────────────────────────────────
export const AddProposalServiceSchema = z.object({
    serviceName: z.string().min(1),
    dateFrom: z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    dateTo: z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    buyPrice: z.number().nonnegative().optional(),
    sellPrice: z.number().nonnegative().optional(),
    quantity: z.number().int().nonnegative().optional(),
    days: z.number().int().nonnegative().optional(),
    notes: z.string().max(2000).optional(),
});

export const UpdateProposalServiceSchema = z.object({
    serviceName: z.string().min(1).optional(),
    dateFrom: z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    dateTo: z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    buyPrice: z.number().nonnegative().optional(),
    sellPrice: z.number().nonnegative().optional(),
    quantity: z.number().int().nonnegative().optional(),
    days: z.number().int().nonnegative().optional(),
    notes: z.string().max(2000).optional(),
    includedInTotal: z.boolean().optional(),
});

// ── Toggle Hotel Inclusion in Proposal Total ───────────────────────────────
export const ToggleProposalHotelSchema = z.object({
    includedInTotal: z.boolean(),
});

// ── Preview PDF ──────────────────────────────────────────────────────────
export const PreviewPdfSchema = z.object({
    language: z.enum(['en', 'de']).optional(),
});

// ── Send Proposal ─────────────────────────────────────────────────────────
// `language` selects the PDF (and email body) language used when the offer
// is sent to the customer. Defaults to English when omitted, so legacy
// callers keep working without changes.
export const SendProposalSchema = z.object({
    sendToEmail: z.string().email().optional(),
    sendToEmails: z.array(z.string().email()).min(1).max(20).optional(),
    language: z.enum(['en', 'de']).optional(),
}).refine(
    (d) => !(d.sendToEmail && d.sendToEmails),
    { message: 'Provide either sendToEmail or sendToEmails, not both' },
);

// ── Download PDF ─────────────────────────────────────────────────────────
// Used by both `GET /:id/pdf` and `GET /:id/offers/:offerId/pdf`. When
// `language` is provided we re-generate the PDF in the requested language
// instead of returning the cached blob. Omitted = serve cached.
export const DownloadPdfQuerySchema = z.object({
    language: z.enum(['en', 'de']).optional(),
});

// ── Approve / Decline Proposal ───────────────────────────────────────────────
export const ApproveProposalSchema = z.object({
    agentEmail: z.string().email().optional(),
    adminNotes: z.string().max(2000).optional(),
    language: z.enum(['en', 'de']).optional(),
});

export const DeclineProposalSchema = z.object({
    rejectionReason: z.string().min(1, 'Rejection reason is required').max(2000),
});

// ── Proposal Hotel: Cancellation Deadline Override ──────────────────────────
// PATCH /api/v1/proposals/:id/hotels/:hotelId/cancellation
//
// Staff can override the supplier-set cancellation deadline. Passing
// `cancelDeadlineOverride: null` (or omitting it with `clear: true`) resets
// to the supplier's date. Application-layer guard enforces that the override
// must be EARLIER than the supplier's `cancelDeadline` — staff can be more
// conservative but cannot promise a later date than the supplier allows.
export const UpdateProposalHotelCancellationSchema = z.object({
    cancelDeadlineOverride: z
        .string()
        .nullable()
        .refine((v) => v === null || !isNaN(Date.parse(v)), {
            message: 'Invalid date (expected ISO 8601 or null to clear)',
        }),
});

// ── Proposal: Payment Deadline ──────────────────────────────────────────────
// PATCH /api/v1/proposals/:id/payment-deadline
//
// Staff sets a single payment deadline for the whole proposal. Pass
// `paymentDeadline: null` to clear (which makes the offer unsendable
// again until staff re-sets it). Application-layer guard enforces:
//   1. Date is in the future (>= today)
//   2. Date is earlier than the earliest effective cancellation deadline
//      across all hotels on the proposal (customer must pay before any
//      cancellation window closes — otherwise SETT eats the penalty).
export const UpdateProposalPaymentDeadlineSchema = z.object({
    paymentDeadline: z
        .string()
        .nullable()
        .refine((v) => v === null || !isNaN(Date.parse(v)), {
            message: 'Invalid date (expected ISO 8601 or null to clear)',
        }),
});

// ── Settings: General Configuration ─────────────────────────────────────────
// `defaultMarkupPercentage` is stored as a decimal string. Accepts up to ten
// integer digits plus an optional fractional part (e.g. "0", "18", "879.8",
// "9999999999"). Range 0–9999999999 — a non-cap for practical purposes; the
// upper bound exists to keep the column from accepting infinity.
export const UpdateGeneralConfigSchema = z.object({
    defaultMarkupPercentage: z
        .string()
        .regex(/^\d{1,10}(\.\d+)?$/, 'Must be a non-negative number with up to 10 integer digits')
        .refine((v) => {
            const n = parseFloat(v);
            return Number.isFinite(n) && n >= 0 && n <= 9_999_999_999;
        }, {
            message: 'Markup must be between 0 and 9999999999',
        }),
});

// ── Settings: Email Configuration (Brevo SMTP) ──────────────────────────────
// Sender-identity fields per `email-config-settings-handover.md` §4.2. All
// four fields are OPTIONAL so the FE can send partial updates. Empty string
// is accepted on the email fields and means "clear this value; the BE will
// fall back to env at send time".
const optionalSettingsEmail = z
    .string()
    .max(120)
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
        message: 'Invalid email address',
    })
    .optional();

export const UpdateEmailConfigSchema = z.object({
    fromName: z
        .string()
        .max(80)
        .refine((v) => !/[\r\n]/.test(v), { message: 'Sender name must not contain newlines' })
        .optional(),
    fromEmail: optionalSettingsEmail,
    replyToFallback: optionalSettingsEmail,
    staffNotificationEmail: optionalSettingsEmail,
});

// POST /api/v1/settings/email/test-send — sends a sample mail via Brevo.
export const SendTestEmailSchema = z.object({
    to: z.string().email('Invalid email address'),
});

// ── Settings: Company Details ───────────────────────────────────────────────
export const UpdateCompanyDetailsSchema = z.object({
    companyName: z.string().min(1, 'Company name is required'),
    assignedPerson: z.string().min(1, 'Assigned person is required'),
    emailAddress: z.string().email('Invalid email address'),
    phoneNumber: z.string().min(5, 'Phone number is required'),
    phoneCountryCode: z.string()
        .regex(/^\+\d{1,5}$/, 'Country code must start with + followed by 1-5 digits')
        .max(8)
        .optional()
        .nullable(),
    website: z.string().min(1, 'Website is required'),
    taxId: z.string().min(1, 'Tax ID is required'),
    address: z.string().min(1, 'Address is required'),
});

// ── Settings: Policies ──────────────────────────────────────────────────────
export const UpdatePoliciesSchema = z.object({
    termsConditionsEn: z.string().optional(),
    termsConditionsDe: z.string().optional(),
    cancellationConditionsEn: z.string().optional(),
    cancellationConditionsDe: z.string().optional(),
});

// ── Settings: Supplier Limits ───────────────────────────────────────────────
// Priority tier (2026-07-XX, per Oliver's ask). Controls the allocation
// order during hotel search — HIGH picked first, AVOID last. Within the
// same tier, cheapest-first is the tie-breaker. Default is MEDIUM.
const SupplierPriorityEnum = z.enum(['HIGH', 'MEDIUM', 'LOW', 'AVOID']);

export const CreateSupplierLimitSchema = z.object({
    // supplierCode is NOT unique — duplicates allowed (e.g. Expedia PKG + SA both EANRP).
    supplierCode: z.string().trim().min(1).max(50),
    providerName: z.string().trim().min(1).max(255),
    accCode: z.string().trim().max(50).nullable().optional(),
    maxRooms: z.number().int().min(0).optional(),
    groupsAllowed: z.boolean().optional(),
    priority: SupplierPriorityEnum.optional(),
    notes: z.string().max(500).nullable().optional(),
});

export const UpdateSupplierLimitSchema = z.object({
    // supplierCode is the WBE matching key. It can be renamed here, but it must
    // always match the code WBE returns or the supplier's room cap stops applying.
    supplierCode: z.string().trim().min(1).max(50).optional(),
    providerName: z.string().trim().min(1).max(255).optional(),
    accCode: z.string().trim().max(50).nullable().optional(),
    maxRooms: z.number().int().min(0).optional(),
    groupsAllowed: z.boolean().optional(),
    priority: SupplierPriorityEnum.optional(),
    notes: z.string().max(500).nullable().optional(),
});

export const SupplierLimitsQuerySchema = z.object({
    search: z.string().optional(),
    page: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 1)),
    limit: z
        .string()
        .optional()
        .transform((v) => (v ? Math.min(parseInt(v, 10), 100) : 20)),
});

// ── Hotel Search (DB query) ────────────────────────────────────────────────
export const HotelSearchQuerySchema = z.object({
    q: z.string().optional(),
    destinationId: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : undefined)),
    starRating: z
        .string()
        .optional()
        .transform((v) => (v ? parseFloat(v) : undefined)),
    limit: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 20)),
    offset: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 0)),
});

// ── WBE Hotel Search (Create Request flow) ────────────────────────────────
export const WbeHotelSearchSchema = z.object({
    /** Meal type filter. 'BB' = breakfast, 'RO' = room only. Omit to accept all. */
    mealType: z.enum(['BB', 'RO', 'HB', 'FB', 'AI']).optional(),
    /** If true (default), also search hotels at starRating ±1. */
    includeAlternativeStars: z.boolean().optional(),
    /** WBE API wait seconds. Default: 35, max: 60. */
    waitSeconds: z.number().int().min(5).max(60).optional(),
    /** Currency code override. Falls back to request currency. */
    currencyCode: z.string().min(2).max(10).optional(),
    /** Nationality code override. Falls back to request nationalityCode. */
    nationalityCode: z.string().min(1).max(10).optional(),
    /** Filter hotels by facility/amenity IDs. Only hotels with ALL listed facilities are included. */
    facilityIds: z.array(z.number().int().positive()).optional(),
    /** Frontend portal language. Determines which language the hotel description is returned in. */
    lang: z.enum(['en', 'de']).optional(),
});

// ── Option Details (Step 6) ───────────────────────────────────────────────
const OptionDetailSelectionSchema = z.object({
    sessionId: z.string().min(1),
    tid: z.string().min(1),
    hotelCode: z.string().min(1),
});

export const OptionDetailsRequestSchema = z.object({
    selections: z.array(OptionDetailSelectionSchema).min(1).max(20),
});

// ── Price Calculation (Step 7) ────────────────────────────────────────────
export const PriceCalculationSchema = z.object({
    /**
     * Legacy single-price input. When present alone, the endpoint returns
     * one { buyingPrice, sellPrice, markupPercent } object — same as
     * before, no behaviour change for existing callers.
     */
    buyingPrice: z.number().positive().optional(),
    markupPercent: z.number().min(0).max(100).optional(),
    /**
     * Per-type input (2026-07-14). When present, the endpoint returns
     * a per-type breakdown with the full calculation trail. Used by the
     * "Show calculation" panel on the staff Add-Hotel / Added-Hotels
     * views. At least one of `buyingPrice` or `perType` must be provided.
     */
    perType: z
        .array(z.object({
            roomType: z.string().min(1).max(40),
            buyingPrice: z.number().positive(),
        }))
        .min(1)
        .optional(),
}).refine(
    (v) => v.buyingPrice !== undefined || (v.perType !== undefined && v.perType.length > 0),
    { message: 'Either `buyingPrice` or `perType` (non-empty) is required.' },
);

// ── Settings: Staff Management ─────────────────────────────────────────────
export const ListStaffQuerySchema = z.object({
    search: z.string().optional(),
    status: z
        .enum(['active', 'blocked', ''])
        .optional()
        .transform((v) => (v === '' ? undefined : v)),
    page: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 1)),
    limit: z
        .string()
        .optional()
        .transform((v) => (v ? Math.min(parseInt(v, 10), 100) : 20)),
});

export const AddStaffSchema = z.object({
    fullName: z.string().min(1, 'Full name is required').max(200),
    email: z.string().email('Invalid email address'),
});

export const ToggleStaffStatusSchema = z.object({
    action: z.enum(['block', 'unblock']),
});

export const StaffIdParamSchema = z.object({
    id: z.string().uuid('Invalid staff ID'),
});
