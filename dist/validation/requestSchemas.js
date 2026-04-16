"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceCalculationSchema = exports.OptionDetailsRequestSchema = exports.WbeHotelSearchSchema = exports.HotelSearchQuerySchema = exports.SupplierLimitsQuerySchema = exports.UpdateSupplierLimitSchema = exports.UpdatePoliciesSchema = exports.UpdateCompanyDetailsSchema = exports.UpdateEmailConfigSchema = exports.UpdateGeneralConfigSchema = exports.DeclineProposalSchema = exports.ApproveProposalSchema = exports.SendProposalSchema = exports.ToggleProposalHotelSchema = exports.UpdateProposalServiceSchema = exports.AddProposalServiceSchema = exports.AdjustHotelPricingSchema = exports.AddProposalHotelSchema = exports.UpdateProposalSchema = exports.CreateProposalSchema = exports.ListRequestsQuerySchema = exports.UpdateBookingRequestSchema = exports.CreateBookingRequestSchema = exports.RoomsSchema = void 0;
const zod_1 = require("zod");
// ── Rooms (Step 2 - Room & Accommodations) ─────────────────────────────────
exports.RoomsSchema = zod_1.z.object({
    single: zod_1.z.number().int().min(0).default(0),
    double: zod_1.z.number().int().min(0).default(0),
    twin: zod_1.z.number().int().min(0).default(0),
    triple: zod_1.z.number().int().min(0).default(0),
    quadruple: zod_1.z.number().int().min(0).default(0),
    suites: zod_1.z.number().int().min(0).default(0),
    standardDoubleBeds: zod_1.z.number().int().min(0).default(0),
    twinBeds: zod_1.z.number().int().min(0).default(0),
    extraRoomsNote: zod_1.z.string().trim().max(2000).nullable().optional(),
});
const dateString = (label) => zod_1.z.string().refine((d) => !isNaN(Date.parse(d)), { message: `Invalid ${label}` });
// ── BookingRequest (4-step Create Request form) ────────────────────────────
exports.CreateBookingRequestSchema = zod_1.z
    .object({
    // Step 1: Trip Details
    destinationId: zod_1.z.number().int(),
    destinationName: zod_1.z.string().min(1),
    checkinDate: dateString('check-in date'),
    checkoutDate: dateString('check-out date').optional(),
    /** nights is derived from checkinDate + checkoutDate, but can be supplied directly */
    nights: zod_1.z.number().int().min(1).optional(),
    starRating: zod_1.z.number().min(1).max(6).refine((v) => v * 2 === Math.round(v * 2), { message: 'Star rating must be in 0.5 increments (e.g. 1, 1.5, 2, ... 5.5, 6)' }).optional(),
    budgetRange: zod_1.z.string().max(100).optional(),
    budget: zod_1.z.number().positive().optional(),
    groupType: zod_1.z.string().max(100).optional(),
    groupSize: zod_1.z.number().int().min(1).optional(),
    averageAge: zod_1.z.number().int().min(1).max(120).optional(),
    currencyCode: zod_1.z.string().min(2).max(10).optional(),
    nationalityCode: zod_1.z.string().min(1).max(10).optional(),
    // Step 2: Room & Accommodations
    rooms: exports.RoomsSchema.optional(),
    breakfastPreference: zod_1.z.enum(['BB', 'RO']).optional(),
    hotelLocation: zod_1.z.enum(['central', 'outside_city_center']).optional(),
    specialRequirements: zod_1.z.string().max(5000).nullable().optional(),
    // Step 3: Customer Details
    companyName: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    contactName: zod_1.z.string().optional(),
    contactEmail: zod_1.z.string().email(),
    contactPhone: zod_1.z.string().min(5),
    contactPhoneCountryCode: zod_1.z.string()
        .regex(/^\+\d{1,5}$/, 'Country code must start with + followed by 1-5 digits')
        .max(8)
        .optional()
        .nullable(),
    guestListFileKey: zod_1.z.string().optional(),
    customerNotes: zod_1.z.string().max(5000).nullable().optional(),
    // Step 4: Policies
    termsAndConditions: zod_1.z.string().optional(),
    cancellationConditions: zod_1.z.string().optional(),
    // System
    source: zod_1.z.string().optional(),
    status: zod_1.z.enum(['pending', 'draft']).optional(),
})
    .refine((d) => {
    // Must have nights or checkoutDate to determine stay length
    if (!d.nights && !d.checkoutDate)
        return false;
    if (d.checkoutDate) {
        const diff = (new Date(d.checkoutDate).getTime() - new Date(d.checkinDate).getTime()) /
            86400000;
        return diff >= 1;
    }
    return true;
}, { message: 'Either nights or checkoutDate must be provided and checkout must be after checkin' })
    .refine((d) => {
    if (!d.groupType)
        return true;
    const normalized = d.groupType.toLowerCase().replace(/[\s-]+/g, '_');
    const ageRequired = normalized === 'youth_group' || normalized === 'school_group';
    return !ageRequired || typeof d.averageAge === 'number';
}, { message: 'averageAge is required when groupType is Youth Group or School Group', path: ['averageAge'] });
exports.UpdateBookingRequestSchema = zod_1.z.object({
    // Step 1
    destinationId: zod_1.z.number().int().optional(),
    destinationName: zod_1.z.string().min(1).optional(),
    checkinDate: dateString('check-in date').optional(),
    checkoutDate: dateString('check-out date').optional(),
    nights: zod_1.z.number().int().min(1).optional(),
    starRating: zod_1.z.number().min(1).max(6).refine((v) => v * 2 === Math.round(v * 2), { message: 'Star rating must be in 0.5 increments (e.g. 1, 1.5, 2, ... 5.5, 6)' }).optional(),
    budgetRange: zod_1.z.string().max(100).optional(),
    budget: zod_1.z.number().positive().optional(),
    groupType: zod_1.z.string().max(100).optional(),
    groupSize: zod_1.z.number().int().min(1).optional(),
    averageAge: zod_1.z.number().int().min(1).max(120).nullable().optional(),
    currencyCode: zod_1.z.string().min(2).max(10).optional(),
    nationalityCode: zod_1.z.string().min(1).max(10).optional(),
    // Step 2
    rooms: exports.RoomsSchema.optional(),
    breakfastPreference: zod_1.z.enum(['BB', 'RO']).optional(),
    hotelLocation: zod_1.z.enum(['central', 'outside_city_center']).optional(),
    specialRequirements: zod_1.z.string().max(5000).nullable().optional(),
    // Step 3
    companyName: zod_1.z.string().min(1).optional(),
    firstName: zod_1.z.string().min(1).optional(),
    lastName: zod_1.z.string().min(1).optional(),
    contactName: zod_1.z.string().optional(),
    contactEmail: zod_1.z.string().email().optional(),
    contactPhone: zod_1.z.string().min(5).optional(),
    contactPhoneCountryCode: zod_1.z.string()
        .regex(/^\+\d{1,5}$/, 'Country code must start with + followed by 1-5 digits')
        .max(8)
        .optional()
        .nullable(),
    guestListFileKey: zod_1.z.string().optional(),
    customerNotes: zod_1.z.string().max(5000).nullable().optional(),
    // Step 4
    termsAndConditions: zod_1.z.string().optional(),
    cancellationConditions: zod_1.z.string().optional(),
    // System
    source: zod_1.z.string().optional(),
    status: zod_1.z.enum(['pending', 'draft', 'processing', 'ai_generated', 'completed', 'cancelled', 'sent', 'declined']).optional(),
}).superRefine((d, ctx) => {
    if (d.groupType === undefined)
        return;
    const normalized = (d.groupType ?? '').toLowerCase().replace(/[\s-]+/g, '_');
    const ageRequired = normalized === 'youth_group' || normalized === 'school_group';
    if (ageRequired && (d.averageAge === undefined || d.averageAge === null)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ['averageAge'],
            message: 'averageAge is required when groupType is Youth Group or School Group',
        });
    }
});
// ── Group Requests list (pagination + search + filter) ─────────────────────
exports.ListRequestsQuerySchema = zod_1.z.object({
    page: zod_1.z.string().optional().transform((v) => (v ? parseInt(v, 10) : 1)),
    limit: zod_1.z.string().optional().transform((v) => (v ? Math.min(parseInt(v, 10), 100) : 20)),
    search: zod_1.z.string().optional(),
    status: zod_1.z
        .enum(['pending', 'draft', 'processing', 'ai_generated', 'completed', 'cancelled', 'sent', 'declined', ''])
        .optional()
        .transform((v) => v || undefined),
    dateFrom: zod_1.z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid dateFrom' }),
    dateTo: zod_1.z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid dateTo' }),
    sortBy: zod_1.z.enum(['createdAt', 'checkinDate', 'referenceNumber']).optional().default('createdAt'),
    sortOrder: zod_1.z.enum(['asc', 'desc']).optional().default('desc'),
});
// ── Proposal ───────────────────────────────────────────────────────────────
// Zod v4: z.record requires (keyType, valueType) — use z.string() as key type
exports.CreateProposalSchema = zod_1.z.object({
    notes: zod_1.z.string().max(5000).optional(),
    markupSettings: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
});
exports.UpdateProposalSchema = exports.CreateProposalSchema.partial();
// ── ProposalHotel ──────────────────────────────────────────────────────────
const RoomDetailSchema = zod_1.z.object({
    net: zod_1.z.number().nonnegative(),
    sell: zod_1.z.number().nonnegative(),
    qty: zod_1.z.number().int().nonnegative(),
    nights: zod_1.z.number().int().nonnegative(),
});
exports.AddProposalHotelSchema = zod_1.z.object({
    hotelCode: zod_1.z.string().min(1),
    hotelName: zod_1.z.string().max(500).optional(),
    tid: zod_1.z.string().optional(),
    rooms: zod_1.z.record(zod_1.z.string(), RoomDetailSchema).optional(),
    currency: zod_1.z.string().min(2).max(10),
    totalPrice: zod_1.z.number().nonnegative(),
    freeCancellation: zod_1.z.boolean().optional(),
    cancelDeadline: zod_1.z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    supplierCode: zod_1.z.string().optional(),
    optionDetailsId: zod_1.z.string().uuid().optional(),
    latitude: zod_1.z.number().min(-90).max(90).optional().nullable(),
    longitude: zod_1.z.number().min(-180).max(180).optional().nullable(),
});
exports.AdjustHotelPricingSchema = zod_1.z.object({
    rooms: zod_1.z.record(zod_1.z.string(), zod_1.z.object({
        net: zod_1.z.number().nonnegative().optional(),
        sell: zod_1.z.number().nonnegative().optional(),
        qty: zod_1.z.number().int().nonnegative().optional(),
        nights: zod_1.z.number().int().nonnegative().optional(),
    })).optional(),
    totalPrice: zod_1.z.number().nonnegative().optional(),
    currency: zod_1.z.string().min(2).max(10).optional(),
});
// ── ProposalService ────────────────────────────────────────────────────────
exports.AddProposalServiceSchema = zod_1.z.object({
    serviceName: zod_1.z.string().min(1),
    dateFrom: zod_1.z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    dateTo: zod_1.z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    buyPrice: zod_1.z.number().nonnegative().optional(),
    sellPrice: zod_1.z.number().nonnegative().optional(),
    quantity: zod_1.z.number().int().nonnegative().optional(),
    days: zod_1.z.number().int().nonnegative().optional(),
    notes: zod_1.z.string().max(2000).optional(),
});
exports.UpdateProposalServiceSchema = zod_1.z.object({
    serviceName: zod_1.z.string().min(1).optional(),
    dateFrom: zod_1.z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    dateTo: zod_1.z
        .string()
        .optional()
        .nullable()
        .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid date' }),
    buyPrice: zod_1.z.number().nonnegative().optional(),
    sellPrice: zod_1.z.number().nonnegative().optional(),
    quantity: zod_1.z.number().int().nonnegative().optional(),
    days: zod_1.z.number().int().nonnegative().optional(),
    notes: zod_1.z.string().max(2000).optional(),
    includedInTotal: zod_1.z.boolean().optional(),
});
// ── Toggle Hotel Inclusion in Proposal Total ───────────────────────────────
exports.ToggleProposalHotelSchema = zod_1.z.object({
    includedInTotal: zod_1.z.boolean(),
});
// ── Send Proposal ─────────────────────────────────────────────────────────
exports.SendProposalSchema = zod_1.z.object({
    sendToEmail: zod_1.z.string().email().optional(),
    sendToEmails: zod_1.z.array(zod_1.z.string().email()).min(1).max(20).optional(),
}).refine((d) => !(d.sendToEmail && d.sendToEmails), { message: 'Provide either sendToEmail or sendToEmails, not both' });
// ── Approve / Decline Proposal ───────────────────────────────────────────────
exports.ApproveProposalSchema = zod_1.z.object({
    agentEmail: zod_1.z.string().email().optional(),
    adminNotes: zod_1.z.string().max(2000).optional(),
});
exports.DeclineProposalSchema = zod_1.z.object({
    rejectionReason: zod_1.z.string().min(1, 'Rejection reason is required').max(2000),
});
// ── Settings: General Configuration ─────────────────────────────────────────
exports.UpdateGeneralConfigSchema = zod_1.z.object({
    defaultMarkupPercentage: zod_1.z
        .string()
        .regex(/^\d{1,3}$/, 'Must be a number between 0 and 100')
        .refine((v) => parseInt(v, 10) >= 0 && parseInt(v, 10) <= 100, {
        message: 'Markup must be between 0 and 100',
    }),
});
// ── Settings: Email Configuration ───────────────────────────────────────────
exports.UpdateEmailConfigSchema = zod_1.z.object({
    smtpHost: zod_1.z.string().min(1, 'SMTP host is required'),
    smtpPort: zod_1.z.string().regex(/^\d+$/, 'Port must be a number'),
    smtpUsername: zod_1.z.string().min(1, 'Username is required'),
    smtpPassword: zod_1.z.string().optional(),
    fromEmail: zod_1.z.string().email('Invalid from email'),
    fromName: zod_1.z.string().min(1, 'From name is required'),
});
// ── Settings: Company Details ───────────────────────────────────────────────
exports.UpdateCompanyDetailsSchema = zod_1.z.object({
    companyName: zod_1.z.string().min(1, 'Company name is required'),
    assignedPerson: zod_1.z.string().min(1, 'Assigned person is required'),
    emailAddress: zod_1.z.string().email('Invalid email address'),
    phoneNumber: zod_1.z.string().min(5, 'Phone number is required'),
    phoneCountryCode: zod_1.z.string()
        .regex(/^\+\d{1,5}$/, 'Country code must start with + followed by 1-5 digits')
        .max(8)
        .optional()
        .nullable(),
    website: zod_1.z.string().min(1, 'Website is required'),
    taxId: zod_1.z.string().min(1, 'Tax ID is required'),
    address: zod_1.z.string().min(1, 'Address is required'),
});
// ── Settings: Policies ──────────────────────────────────────────────────────
exports.UpdatePoliciesSchema = zod_1.z.object({
    termsConditionsEn: zod_1.z.string().optional(),
    termsConditionsDe: zod_1.z.string().optional(),
    cancellationConditionsEn: zod_1.z.string().optional(),
    cancellationConditionsDe: zod_1.z.string().optional(),
});
// ── Settings: Supplier Limits ───────────────────────────────────────────────
exports.UpdateSupplierLimitSchema = zod_1.z.object({
    maxRooms: zod_1.z.number().int().min(0).optional(),
    groupsAllowed: zod_1.z.boolean().optional(),
    notes: zod_1.z.string().max(500).nullable().optional(),
});
exports.SupplierLimitsQuerySchema = zod_1.z.object({
    search: zod_1.z.string().optional(),
    page: zod_1.z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 1)),
    limit: zod_1.z
        .string()
        .optional()
        .transform((v) => (v ? Math.min(parseInt(v, 10), 100) : 20)),
});
// ── Hotel Search (DB query) ────────────────────────────────────────────────
exports.HotelSearchQuerySchema = zod_1.z.object({
    q: zod_1.z.string().optional(),
    destinationId: zod_1.z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : undefined)),
    starRating: zod_1.z
        .string()
        .optional()
        .transform((v) => (v ? parseFloat(v) : undefined)),
    limit: zod_1.z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 20)),
    offset: zod_1.z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 0)),
});
// ── WBE Hotel Search (Create Request flow) ────────────────────────────────
exports.WbeHotelSearchSchema = zod_1.z.object({
    /** Meal type filter. 'BB' = breakfast, 'RO' = room only. Omit to accept all. */
    mealType: zod_1.z.enum(['BB', 'RO', 'HB', 'FB', 'AI']).optional(),
    /** If true (default), also search hotels at starRating ±1. */
    includeAlternativeStars: zod_1.z.boolean().optional(),
    /** WBE API wait seconds. Default: 35, max: 60. */
    waitSeconds: zod_1.z.number().int().min(5).max(60).optional(),
    /** Currency code override. Falls back to request currency. */
    currencyCode: zod_1.z.string().min(2).max(10).optional(),
    /** Nationality code override. Falls back to request nationalityCode. */
    nationalityCode: zod_1.z.string().min(1).max(10).optional(),
    /** Filter hotels by facility/amenity IDs. Only hotels with ALL listed facilities are included. */
    facilityIds: zod_1.z.array(zod_1.z.number().int().positive()).optional(),
});
// ── Option Details (Step 6) ───────────────────────────────────────────────
const OptionDetailSelectionSchema = zod_1.z.object({
    sessionId: zod_1.z.string().min(1),
    tid: zod_1.z.string().min(1),
    hotelCode: zod_1.z.string().min(1),
});
exports.OptionDetailsRequestSchema = zod_1.z.object({
    selections: zod_1.z.array(OptionDetailSelectionSchema).min(1).max(20),
});
// ── Price Calculation (Step 7) ────────────────────────────────────────────
exports.PriceCalculationSchema = zod_1.z.object({
    buyingPrice: zod_1.z.number().positive(),
    markupPercent: zod_1.z.number().min(0).max(100).optional(),
});
