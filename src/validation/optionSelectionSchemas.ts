import { z } from 'zod';

/**
 * Request validation for the customer-facing selection endpoints.
 *
 * These routes are reached without a login — the token in the customer's link
 * is the only credential — so validation here is the outer boundary of the
 * system rather than a convenience for a signed-in caller.
 */

/**
 * The token from the selection link.
 *
 * Length is bounded on both sides: too short cannot be one of ours, and an
 * unbounded string is an invitation to send megabytes at an unauthenticated
 * endpoint. The character class matches base64url, which is what the service
 * generates.
 */
export const SelectionTokenParamSchema = z.object({
    token: z
        .string()
        .min(20, 'selection token is not valid')
        .max(128, 'selection token is not valid')
        .regex(/^[A-Za-z0-9_-]+$/, 'selection token is not valid'),
});

/**
 * POST /api/v1/select/:token — record the customer's choice.
 *
 * `acceptTerms` is deliberately not defaulted. A default of false would be
 * indistinguishable from a customer who never saw the acceptance step, and a
 * default of true would manufacture consent — so the caller must state it.
 */
export const SubmitSelectionSchema = z.object({
    hotelCode: z.string().trim().min(1, 'hotelCode is required').max(255),

    /**
     * Explicit acceptance of the stated price and conditions. Required for a
     * non-refundable rate; the service refuses the selection without it.
     */
    acceptTerms: z.boolean().optional(),

    /** Who is choosing, for the record of who accepted what. */
    selectedByEmail: z.string().email('selectedByEmail must be an email').optional(),
});

/** POST /api/v1/proposals/:id/selection — staff recording a phone confirmation. */
export const RecordSelectionSchema = z.object({
    hotelCode: z.string().trim().min(1, 'hotelCode is required').max(255),
    acceptTerms: z.boolean().optional(),
    /**
     * The customer this was agreed with. Recorded because a staff-entered
     * selection has no IP or user agent of the customer's own — the staff
     * member's identity and this address are the whole audit trail.
     */
    selectedByEmail: z.string().email('selectedByEmail must be an email').optional(),
});

export const ProposalIdParamSchema = z.object({
    id: z.string().uuid('proposal id must be a UUID'),
});

export const SelectionIdParamSchema = z.object({
    id: z.string().uuid('selection id must be a UUID'),
});

export type SubmitSelectionInput = z.infer<typeof SubmitSelectionSchema>;
export type RecordSelectionInput = z.infer<typeof RecordSelectionSchema>;
