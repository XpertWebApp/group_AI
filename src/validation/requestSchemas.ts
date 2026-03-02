import { z } from 'zod';

// ── Rooms ──────────────────────────────────────────────────────────────────
export const RoomsSchema = z.object({
    single: z.number().int().min(0).default(0),
    double: z.number().int().min(0).default(0),
    twin: z.number().int().min(0).default(0),
    triple: z.number().int().min(0).default(0),
    quadruple: z.number().int().min(0).default(0),
    suites: z.number().int().min(0).default(0),
    extraRoomsNote: z.string().trim().max(2000).nullable().optional(),
});

// ── BookingRequest ─────────────────────────────────────────────────────────
export const CreateBookingRequestSchema = z.object({
    source: z.string().optional(),
    companyName: z.string().min(1),
    contactName: z.string().min(1),
    contactEmail: z.string().email(),
    contactPhone: z.string().min(5),
    currencyCode: z.string().min(2).max(10),
    destinationId: z.number().int(),
    destinationName: z.string().min(1),
    checkinDate: z
        .string()
        .refine((d) => !isNaN(Date.parse(d)), { message: 'Invalid date' }),
    nights: z.number().int().min(1),
    rooms: RoomsSchema,
    nationalityCode: z.string().min(1).max(10).optional(),
    budget: z.number().positive().optional(),
    specialRequirements: z.string().max(5000).nullable().optional(),
    status: z.enum(['pending', 'draft']).optional(),
});

export const UpdateBookingRequestSchema = CreateBookingRequestSchema.partial();

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

// ── Send Proposal ─────────────────────────────────────────────────────────
export const SendProposalSchema = z.object({
    sendToEmail: z.string().email().optional(),
});

// ── Hotel Search ──────────────────────────────────────────────────────────
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
