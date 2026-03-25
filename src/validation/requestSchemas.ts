import { z } from 'zod';

// ── Rooms (Step 2 - Room & Accommodations) ─────────────────────────────────
export const RoomsSchema = z.object({
    single: z.number().int().min(0).default(0),
    double: z.number().int().min(0).default(0),
    twin: z.number().int().min(0).default(0),
    triple: z.number().int().min(0).default(0),
    quadruple: z.number().int().min(0).default(0),
    suites: z.number().int().min(0).default(0),
    extraRoomsNote: z.string().trim().max(2000).nullable().optional(),
});

const dateString = (label: string) =>
    z.string().refine((d) => !isNaN(Date.parse(d)), { message: `Invalid ${label}` });

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
        starRating: z.number().min(1).max(5).optional(),
        budgetRange: z.string().max(100).optional(),
        budget: z.number().positive().optional(),
        groupType: z.string().max(100).optional(),
        groupSize: z.number().int().min(1).optional(),
        currencyCode: z.string().min(2).max(10).optional(),
        nationalityCode: z.string().min(1).max(10).optional(),

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
        guestListFileKey: z.string().optional(),
        customerNotes: z.string().max(5000).nullable().optional(),

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
    );

export const UpdateBookingRequestSchema = z.object({
    // Step 1
    destinationId: z.number().int().optional(),
    destinationName: z.string().min(1).optional(),
    checkinDate: dateString('check-in date').optional(),
    checkoutDate: dateString('check-out date').optional(),
    nights: z.number().int().min(1).optional(),
    starRating: z.number().min(1).max(5).optional(),
    budgetRange: z.string().max(100).optional(),
    budget: z.number().positive().optional(),
    groupType: z.string().max(100).optional(),
    groupSize: z.number().int().min(1).optional(),
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
    guestListFileKey: z.string().optional(),
    customerNotes: z.string().max(5000).nullable().optional(),
    // Step 4
    termsAndConditions: z.string().optional(),
    cancellationConditions: z.string().optional(),
    // System
    source: z.string().optional(),
    status: z.enum(['pending', 'draft', 'processing', 'ai_generated', 'completed', 'cancelled']).optional(),
});

// ── Group Requests list (pagination + search + filter) ─────────────────────
export const ListRequestsQuerySchema = z.object({
    page: z.string().optional().transform((v) => (v ? parseInt(v, 10) : 1)),
    limit: z.string().optional().transform((v) => (v ? Math.min(parseInt(v, 10), 100) : 20)),
    search: z.string().optional(),
    status: z
        .enum(['pending', 'draft', 'processing', 'ai_generated', 'completed', 'cancelled', ''])
        .optional()
        .transform((v) => v || undefined),
    dateFrom: z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid dateFrom' }),
    dateTo: z.string().optional().refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid dateTo' }),
    sortBy: z.enum(['createdAt', 'checkinDate', 'referenceNumber']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
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
});

export const AddProposalHotelSchema = z.object({
    hotelCode: z.string().min(1),
    hotelName: z.string().max(500).optional(),
    tid: z.string().optional(),
    rooms: z.record(z.string(), RoomDetailSchema).optional(),
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
});

export const AdjustHotelPricingSchema = z.object({
    rooms: z.record(z.string(), z.object({
        net: z.number().nonnegative().optional(),
        sell: z.number().nonnegative().optional(),
        qty: z.number().int().nonnegative().optional(),
        nights: z.number().int().nonnegative().optional(),
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
});

// ── Send Proposal ─────────────────────────────────────────────────────────
export const SendProposalSchema = z.object({
    sendToEmail: z.string().email().optional(),
});

// ── Approve / Decline Proposal ───────────────────────────────────────────────
export const ApproveProposalSchema = z.object({
    agentEmail: z.string().email().optional(),
    adminNotes: z.string().max(2000).optional(),
});

export const DeclineProposalSchema = z.object({
    rejectionReason: z.string().min(1, 'Rejection reason is required').max(2000),
});

// ── Settings: General Configuration ─────────────────────────────────────────
export const UpdateGeneralConfigSchema = z.object({
    defaultMarkupPercentage: z
        .string()
        .regex(/^\d{1,3}$/, 'Must be a number between 0 and 100')
        .refine((v) => parseInt(v, 10) >= 0 && parseInt(v, 10) <= 100, {
            message: 'Markup must be between 0 and 100',
        }),
});

// ── Settings: Email Configuration ───────────────────────────────────────────
export const UpdateEmailConfigSchema = z.object({
    smtpHost: z.string().min(1, 'SMTP host is required'),
    smtpPort: z.string().regex(/^\d+$/, 'Port must be a number'),
    smtpUsername: z.string().min(1, 'Username is required'),
    smtpPassword: z.string().optional(),
    fromEmail: z.string().email('Invalid from email'),
    fromName: z.string().min(1, 'From name is required'),
});

// ── Settings: Company Details ───────────────────────────────────────────────
export const UpdateCompanyDetailsSchema = z.object({
    companyName: z.string().min(1, 'Company name is required'),
    assignedPerson: z.string().min(1, 'Assigned person is required'),
    emailAddress: z.string().email('Invalid email address'),
    phoneNumber: z.string().min(5, 'Phone number is required'),
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
export const UpdateSupplierLimitSchema = z.object({
    maxRooms: z.number().int().min(0).optional(),
    groupsAllowed: z.boolean().optional(),
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
    buyingPrice: z.number().positive(),
    markupPercent: z.number().min(0).max(100).optional(),
});
