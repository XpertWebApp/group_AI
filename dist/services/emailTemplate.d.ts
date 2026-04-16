/**
 * SETT Hub — Branded Email Templates
 *
 * Based on SETT-Hub-Brand-Guidelines-v2:
 *   - Colors: Navy #071c42, Green #AAC737, Grey #686868, White #FFFFFF
 *   - Font: Montserrat (Google Fonts), fallback Arial/Helvetica
 *   - Logos: Group Offer logo for group emails, SVG logo for general
 *   - Tone: Professional, confident, not corporate-stiff
 *
 * Email Template Rules (from brand guidelines):
 *   - Inline CSS only (Gmail strips <style> blocks)
 *   - Table-based layout, max width 600px
 *   - No base64 images — use hosted URLs only
 *   - No CSS animations
 *   - CTA button: green #AAC737, navy text, 12px 28px padding, 4px radius
 */
/**
 * Staff notification: new AI-generated group offer ready for review.
 * Uses GROUP OFFER logo (§4.5: "Email header (group offers) → Group-offer--big-2.png")
 */
export declare function buildOfferReadyEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    dashboardUrl?: string;
}): string;
/**
 * Staff notification: insufficient inventory — partial offer saved.
 * Uses GROUP OFFER logo.
 */
export declare function buildInsufficientInventoryEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    roomsNeeded: number;
    roomsFound: number;
    roomsMissing: number;
    hotelsAccepted: number;
    suggestion: string;
    dashboardUrl?: string;
}): string;
/**
 * Staff notification: offer declined by admin.
 * Uses GENERAL logo (not group-specific context).
 */
export declare function buildOfferDeclinedEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    rejectionReason: string;
    dashboardUrl?: string;
}): string;
/**
 * Client-facing: offer PDF email sent to agent.
 * Uses GROUP OFFER logo (§4.5: "AI-generated group offers").
 * IMPORTANT: This is a client-facing email — use branded HTML template.
 */
export declare function buildOfferPdfEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
}): string;
/**
 * Staff notification: offer generation pipeline failed.
 * Uses GENERAL logo (system notification, not group-specific).
 */
export declare function buildOfferGenerationFailedEmail(opts: {
    referenceNumber: number;
    reason: string;
    dashboardUrl?: string;
}): string;
