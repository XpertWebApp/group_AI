import { EmailSendResult } from './email/emailErrors';
export declare class NotificationService {
    /**
     * Create an in-app notification record and optionally send an email.
     */
    notify(opts: {
        type: string;
        title: string;
        message: string;
        entityId?: string;
        entityType?: string;
        email?: {
            to: string;
            subject: string;
            html: string;
        };
    }): Promise<{
        id: string;
        createdAt: Date;
        message: string;
        type: string;
        entityId: string | null;
        title: string;
        entityType: string | null;
        read: boolean;
    }>;
    sendEmail(to: string, subject: string, html: string): Promise<void>;
    /**
     * Notify staff that a new AI-generated offer is ready for review.
     */
    notifyNewOfferReady(opts: {
        requestId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        staffEmail?: string;
    }): Promise<void>;
    /**
     * Notify staff that offer generation failed so they can handle it manually.
     */
    notifyOfferGenerationFailed(opts: {
        requestId: string;
        referenceNumber: number;
        reason: string;
        staffEmail?: string;
    }): Promise<void>;
    /**
     * Escalate to human when the accumulation gate cannot meet the room target.
     * A partial offer is still created with whatever hotels were accepted.
     * Staff are notified with the shortfall details and a suggested action.
     */
    notifyInsufficientInventory(opts: {
        requestId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        roomsNeeded: number;
        roomsFound: number;
        roomsMissing: number;
        hotelsAccepted: number;
        suggestion: string;
        staffEmail?: string;
    }): Promise<void>;
    /**
     * Notify staff that an offer has been approved and PDF sent to agent.
     */
    notifyOfferApproved(opts: {
        requestId: string;
        proposalId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        approvedBy: string;
        agentEmail?: string;
        staffEmail?: string;
    }): Promise<void>;
    /**
     * Notify staff that an offer has been rejected.
     * Sends both in-app notification and email.
     */
    notifyOfferDeclined(opts: {
        requestId: string;
        proposalId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        rejectedBy: string;
        rejectionReason: string;
        staffEmail?: string;
    }): Promise<void>;
    /**
     * Send an email via Gmail API (if userId provided and connected), otherwise SMTP.
     * Returns an `EmailSendResult` discriminated union.
     *
     * On Gmail failures that require user action (NOT_CONNECTED, TOKEN_REVOKED,
     * GMAIL_FORBIDDEN, etc.), this method does NOT fall back to SMTP — those errors
     * wouldn't be solved by SMTP and we want the real cause surfaced to the caller.
     * For other Gmail failures (network, upstream 5xx), SMTP fallback is attempted.
     */
    sendEmailWithFallback(opts: {
        userId?: string;
        to: string;
        subject: string;
        html: string;
        attachments?: Array<{
            filename: string;
            content: Buffer;
            contentType: string;
        }>;
    }): Promise<EmailSendResult>;
    /**
     * Send approved offer PDF to agent via email.
     * Returns the underlying EmailSendResult so callers can inspect the failure code.
     */
    sendOfferPdfToAgent(opts: {
        agentEmail: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        pdfBuffer: Buffer;
        userId?: string;
    }): Promise<EmailSendResult>;
}
declare const _default: NotificationService;
export default _default;
