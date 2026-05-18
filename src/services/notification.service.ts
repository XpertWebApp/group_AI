import nodemailer, { Transporter } from 'nodemailer';
import { PrismaClient } from '@prisma/client';
import notificationRepository, { CreateNotificationData } from '../repositories/notification.repository';
import failedEmailRepository from '../repositories/failedEmail.repository';
import logger from '../utils/logger';
import {
    buildOfferReadyEmail,
    buildInsufficientInventoryEmail,
    buildOfferDeclinedEmail,
    buildOfferDeclinedContactEmail,
    buildOfferPdfEmail,
    buildOfferGenerationFailedEmail,
    buildNewRequestStaffEmail,
    buildNewRequestContactEmail,
    buildOfferApprovedEmail,
    buildStatusChangeEmail,
} from './emailTemplate';
import { EmailSendResult, failure } from './email/emailErrors';

const prisma = new PrismaClient();

// ─── Transport (Brevo only) ───────────────────────────────────────────────────

/**
 * Resolve "secure" flag for nodemailer from Oliver's canonical SMTP_SECURITY var.
 *  STARTTLS  → secure: false (negotiates TLS after connecting on port 587)
 *  SSL/TLS   → secure: true  (TLS from the start, port 465)
 * Falls back to the legacy SMTP_SECURE boolean for backwards compatibility.
 */
function resolveSecure(): boolean {
    const security = (process.env.SMTP_SECURITY ?? '').toUpperCase();
    if (security === 'SSL' || security === 'TLS') return true;
    if (security === 'STARTTLS') return false;
    return process.env.SMTP_SECURE === 'true';
}

/** Build the From header from Oliver's name+email split, falling back to the legacy combined SMTP_FROM. */
function resolveFrom(): string {
    const name = process.env.SMTP_FROM_NAME;
    const email = process.env.SMTP_FROM_EMAIL;
    if (name && email) return `${name} <${email}>`;
    return process.env.SMTP_FROM ?? 'SETT Groups <groups@s-e-t-t.com>';
}

/** Reply-To fallback (used when the request has no assigned active staff). */
export function resolveReplyToFallback(): string {
    return (
        process.env.SMTP_REPLY_TO ??
        process.env.SMTP_REPLY_TO_FALLBACK ??
        'groups@s-e-t-t.com'
    );
}

function createTransport(): Transporter | null {
    const host = process.env.SMTP_HOST;
    if (!host) return null;

    const user = process.env.SMTP_USERNAME ?? process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD ?? process.env.SMTP_PASS;

    return nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: resolveSecure(),
        auth: user ? { user, pass } : undefined,
    });
}

// ─── Retry policy (3 attempts, exponential backoff) ──────────────────────────

const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Permanent SMTP failures should NOT be retried — auth errors, malformed
 * recipients, etc. won't fix themselves on retry.
 */
function isPermanentSmtpError(err: any): boolean {
    const code = err?.code;
    const responseCode = err?.responseCode;
    if (code === 'EAUTH') return true;                                    // bad credentials
    if (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) {
        // 5xx = permanent SMTP errors (550 mailbox unavailable, 553 invalid recipient, etc.)
        return true;
    }
    return false;
}

// ─── Internal: send with retry + dead-letter ─────────────────────────────────

interface SendInput {
    eventType: string;
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
    requestId?: string;
    proposalId?: string;
    attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

async function sendWithRetry(input: SendInput): Promise<EmailSendResult> {
    const transport = createTransport();
    if (!transport) {
        logger.warn(
            { eventType: input.eventType, to: input.to },
            'SMTP not configured — email not sent (set SMTP_HOST in .env)',
        );
        return { ok: false, method: 'none', failure: failure('SMTP_NOT_CONFIGURED') };
    }

    const from = resolveFrom();
    const replyTo = input.replyTo ?? resolveReplyToFallback();

    let lastError: any;
    for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
        try {
            const info = await transport.sendMail({
                from,
                to: input.to,
                subject: input.subject,
                html: input.html,
                replyTo,
                attachments: input.attachments,
            });
            logger.info(
                {
                    eventType: input.eventType,
                    to: input.to,
                    requestId: input.requestId,
                    proposalId: input.proposalId,
                    messageId: info.messageId,
                    attempt,
                },
                'Email sent',
            );
            return { ok: true, method: 'smtp' };
        } catch (err: any) {
            lastError = err;
            const permanent = isPermanentSmtpError(err);
            logger.warn(
                {
                    eventType: input.eventType,
                    to: input.to,
                    requestId: input.requestId,
                    attempt,
                    errorCode: err?.code,
                    responseCode: err?.responseCode,
                    permanent,
                },
                permanent ? 'Email send permanently failed — skipping retries' : 'Email send attempt failed',
            );
            if (permanent) break;
            if (attempt > RETRY_DELAYS_MS.length) break;
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
        }
    }

    // All retries exhausted (or permanent failure) — dead-letter + alert.
    const errorMessage = lastError?.message ?? String(lastError ?? 'unknown error');
    try {
        const row = await failedEmailRepository.record({
            eventType: input.eventType,
            recipient: input.to,
            subject: input.subject,
            body: input.html,
            replyTo: replyTo ?? null,
            requestId: input.requestId ?? null,
            proposalId: input.proposalId ?? null,
            attempts: RETRY_DELAYS_MS.length + 1,
            lastError: errorMessage,
        });
        logger.error(
            {
                eventType: input.eventType,
                to: input.to,
                requestId: input.requestId,
                failedEmailId: row.id,
                error: errorMessage,
            },
            'Email send exhausted retries — recorded to failed_emails',
        );

        // Best-effort in-app alert so staff see the failure even without admin UI.
        try {
            await notificationRepository.create({
                type: 'email_send_failed',
                title: `Email delivery failed: ${input.eventType}`,
                message:
                    `An outbound email to ${input.to} failed after ${RETRY_DELAYS_MS.length + 1} attempts. ` +
                    `See failed_emails row ${row.id} for details.`,
                entityId: input.requestId ?? input.proposalId,
                entityType: input.requestId ? 'booking_request' : input.proposalId ? 'proposal' : undefined,
            });
        } catch (notifyErr: any) {
            logger.error({ err: notifyErr.message }, 'Failed to create in-app alert for failed email');
        }
    } catch (recordErr: any) {
        logger.error(
            { err: recordErr.message, eventType: input.eventType, to: input.to },
            'Failed to record dead-letter email — losing the message',
        );
    }

    return {
        ok: false,
        method: 'smtp',
        failure: failure('SMTP_FAILED', { detail: errorMessage }),
    };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class NotificationService {
    /**
     * Resolve Reply-To for an INTERNAL staff email about a booking request.
     * Returns the assigned staff member's email when the request is owned and
     * that staff is active; otherwise falls back to the group inbox.
     *
     * Customer-facing emails should NOT use this — they always reply-to the group inbox.
     */
    async resolveStaffReplyTo(requestId?: string): Promise<string> {
        const fallback = resolveReplyToFallback();
        if (!requestId) return fallback;
        try {
            const row = await prisma.bookingRequest.findUnique({
                where: { id: requestId },
                select: {
                    assignedUser: {
                        select: { email: true, isActive: true },
                    },
                },
            });
            const u = row?.assignedUser;
            if (u && u.isActive && u.email) return u.email;
        } catch (err: any) {
            logger.warn({ err: err.message, requestId }, 'resolveStaffReplyTo lookup failed — using fallback');
        }
        return fallback;
    }

    /**
     * Send an email via Brevo SMTP with retry + dead-letter.
     * Returns an EmailSendResult so callers that care about success can inspect
     * the outcome; most callers fire-and-forget.
     */
    async sendEmail(input: SendInput): Promise<EmailSendResult> {
        return sendWithRetry(input);
    }

    /**
     * Create an in-app notification record AND optionally send an email.
     * The email goes through the same retry + dead-letter pipeline as direct sends.
     */
    async notify(opts: {
        type: string;
        title: string;
        message: string;
        entityId?: string;
        entityType?: string;
        email?: {
            eventType: string;
            to: string;
            subject: string;
            html: string;
            replyTo?: string;
            requestId?: string;
            proposalId?: string;
        };
    }) {
        const data: CreateNotificationData = {
            type: opts.type,
            title: opts.title,
            message: opts.message,
            entityId: opts.entityId,
            entityType: opts.entityType,
        };
        const notification = await notificationRepository.create(data);

        if (opts.email) {
            await this.sendEmail({
                eventType: opts.email.eventType,
                to: opts.email.to,
                subject: opts.email.subject,
                html: opts.email.html,
                replyTo: opts.email.replyTo,
                requestId: opts.email.requestId,
                proposalId: opts.email.proposalId,
            });
        }

        return notification;
    }

    // ── Existing triggers (unchanged behaviour, now via Brevo) ────────────────

    /** Staff alert: a new AI-generated offer is ready for review. */
    async notifyNewOfferReady(opts: {
        requestId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        staffEmail?: string;
    }) {
        const title = `New group offer ready for review`;
        const message = `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}) has been generated and is ready for staff review.`;

        const emailHtml = buildOfferReadyEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
            requestId: opts.requestId,
        });

        const replyTo = await this.resolveStaffReplyTo(opts.requestId);

        await this.notify({
            type: 'new_offer_ready',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      eventType: 'new_offer_ready',
                      to: opts.staffEmail,
                      subject: title,
                      html: emailHtml,
                      replyTo,
                      requestId: opts.requestId,
                  }
                : undefined,
        });
    }

    /** Staff alert: offer generation failed and manual handling is required. */
    async notifyOfferGenerationFailed(opts: {
        requestId: string;
        referenceNumber: number;
        reason: string;
        staffEmail?: string;
    }) {
        const title = `Offer generation failed — manual action required`;
        const emailHtml = buildOfferGenerationFailedEmail({
            referenceNumber: opts.referenceNumber,
            reason: opts.reason,
            requestId: opts.requestId,
        });
        const replyTo = await this.resolveStaffReplyTo(opts.requestId);

        await this.notify({
            type: 'offer_generation_failed',
            title,
            message: `Offer #${opts.referenceNumber} could not be generated automatically. Reason: ${opts.reason}. Please handle manually.`,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      eventType: 'offer_generation_failed',
                      to: opts.staffEmail,
                      subject: title,
                      html: emailHtml,
                      replyTo,
                      requestId: opts.requestId,
                  }
                : undefined,
        });
    }

    /** Staff escalation: accumulation gate could not meet the room target. */
    async notifyInsufficientInventory(opts: {
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
    }) {
        const title = `Insufficient inventory — manual action required`;
        const message =
            `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}): ` +
            `only ${opts.roomsFound} of ${opts.roomsNeeded} rooms found across ${opts.hotelsAccepted} hotel(s). ` +
            `${opts.roomsMissing} rooms short. Suggestion: ${opts.suggestion}`;

        const emailHtml = buildInsufficientInventoryEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
            requestId: opts.requestId,
            roomsNeeded: opts.roomsNeeded,
            roomsFound: opts.roomsFound,
            roomsMissing: opts.roomsMissing,
            hotelsAccepted: opts.hotelsAccepted,
            suggestion: opts.suggestion,
        });
        const replyTo = await this.resolveStaffReplyTo(opts.requestId);

        await this.notify({
            type: 'insufficient_inventory',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      eventType: 'insufficient_inventory',
                      to: opts.staffEmail,
                      subject: `Offer #${opts.referenceNumber} — ${opts.roomsMissing} rooms short, manual action needed`,
                      html: emailHtml,
                      replyTo,
                      requestId: opts.requestId,
                  }
                : undefined,
        });
    }

    /**
     * Staff alert: an offer was approved.
     * Phase 1 update: now sends an email in addition to the in-app notification.
     */
    async notifyOfferApproved(opts: {
        requestId: string;
        proposalId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        approvedBy: string;
        agentEmail?: string;
        staffEmail?: string;
    }) {
        const title = `Offer #${opts.referenceNumber} approved`;
        const message = `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}) has been approved.`;

        const emailHtml = buildOfferApprovedEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
            approvedBy: opts.approvedBy,
            proposalId: opts.proposalId,
        });
        const replyTo = await this.resolveStaffReplyTo(opts.requestId);

        await this.notify({
            type: 'offer_approved',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      eventType: 'offer_approved',
                      to: opts.staffEmail,
                      subject: title,
                      html: emailHtml,
                      replyTo,
                      requestId: opts.requestId,
                      proposalId: opts.proposalId,
                  }
                : undefined,
        });
    }

    /** Staff alert: an offer was declined. (Existing behaviour.) */
    async notifyOfferDeclined(opts: {
        requestId: string;
        proposalId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        rejectedBy: string;
        rejectionReason: string;
        staffEmail?: string;
    }) {
        const title = `Offer #${opts.referenceNumber} declined — manual action required`;
        const message =
            `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}) has been declined. ` +
            `Reason: ${opts.rejectionReason}`;

        const emailHtml = buildOfferDeclinedEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
            rejectionReason: opts.rejectionReason,
            proposalId: opts.proposalId,
        });
        const replyTo = await this.resolveStaffReplyTo(opts.requestId);

        await this.notify({
            type: 'offer_declined',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      eventType: 'offer_declined_staff',
                      to: opts.staffEmail,
                      subject: `Offer #${opts.referenceNumber} declined — ${opts.rejectionReason}`,
                      html: emailHtml,
                      replyTo,
                      requestId: opts.requestId,
                      proposalId: opts.proposalId,
                  }
                : undefined,
        });
    }

    // ── New triggers (Phase 1) ────────────────────────────────────────────────

    /** Staff alert: a new booking request was just created (portal or webhook). */
    async notifyNewRequestStaff(opts: {
        requestId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        source: 'portal' | 'wix' | 'wordpress';
        staffEmail?: string;
        groupType?: string | null;
        averageAge?: number | null;
    }) {
        const sourceLabel = opts.source === 'portal' ? 'portal form' : opts.source === 'wix' ? 'Wix webhook' : 'WordPress webhook';
        const title = `New group request received (#${opts.referenceNumber})`;
        const message = `New group request from ${opts.contactName} for ${opts.destinationName} via ${sourceLabel}.`;

        const emailHtml = buildNewRequestStaffEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
            source: sourceLabel,
            requestId: opts.requestId,
            groupType: opts.groupType,
            averageAge: opts.averageAge,
        });
        const replyTo = await this.resolveStaffReplyTo(opts.requestId);

        await this.notify({
            type: 'new_request_staff',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      eventType: 'new_request_staff',
                      to: opts.staffEmail,
                      subject: title,
                      html: emailHtml,
                      replyTo,
                      requestId: opts.requestId,
                  }
                : undefined,
        });
    }

    /** Customer-facing confirmation: "we received your enquiry, quote within 24h". */
    async notifyNewRequestContact(opts: {
        requestId: string;
        referenceNumber: number;
        contactEmail: string;
        contactName: string;
        destinationName: string;
    }) {
        const subject = `We've received your enquiry — Reference #${opts.referenceNumber}`;
        const html = buildNewRequestContactEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
        });

        // Customer-facing — Reply-To is always the group inbox (Read B rule).
        await this.sendEmail({
            eventType: 'new_request_contact',
            to: opts.contactEmail,
            subject,
            html,
            replyTo: resolveReplyToFallback(),
            requestId: opts.requestId,
        });
    }

    /** Customer-facing decline notification (companion to the existing staff-side notifyOfferDeclined). */
    async notifyOfferDeclinedContact(opts: {
        requestId: string;
        proposalId: string;
        referenceNumber: number;
        contactEmail: string;
        contactName: string;
        destinationName: string;
        rejectionReason: string;
    }) {
        const subject = `Update on your group offer — Reference #${opts.referenceNumber}`;
        const html = buildOfferDeclinedContactEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
            rejectionReason: opts.rejectionReason,
        });

        // Customer-facing — Reply-To is the group inbox.
        await this.sendEmail({
            eventType: 'offer_declined_contact',
            to: opts.contactEmail,
            subject,
            html,
            replyTo: resolveReplyToFallback(),
            requestId: opts.requestId,
            proposalId: opts.proposalId,
        });
    }

    /** Staff alert: booking request status transitioned to a tracked state. */
    async notifyStatusChange(opts: {
        requestId: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        fromStatus: string;
        toStatus: string;
        staffEmail?: string;
    }) {
        const title = `Request #${opts.referenceNumber} → ${opts.toStatus}`;
        const message = `Request status changed from ${opts.fromStatus} to ${opts.toStatus}.`;

        const html = buildStatusChangeEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
            fromStatus: opts.fromStatus,
            requestId: opts.requestId,
            toStatus: opts.toStatus,
        });
        const replyTo = await this.resolveStaffReplyTo(opts.requestId);

        await this.notify({
            type: 'status_change',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      eventType: `status_change_${opts.toStatus}`,
                      to: opts.staffEmail,
                      subject: title,
                      html,
                      replyTo,
                      requestId: opts.requestId,
                  }
                : undefined,
        });
    }

    // ── Customer-facing: offer PDF (Brevo only, fixed sender, group reply-to) ─

    /**
     * Send the approved offer PDF to the external contact via Brevo.
     * `userId` is accepted for backwards-compat but no longer used for sending —
     * the Gmail-OAuth path was removed in Phase 1 per Oliver's "Brevo only" rule.
     */
    async sendOfferPdfToAgent(opts: {
        agentEmail: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        pdfBuffer: Buffer;
        userId?: string;
        requestId?: string;
        proposalId?: string;
    }): Promise<EmailSendResult> {
        const subject = `Your Group Offer #${opts.referenceNumber} — ${opts.destinationName}`;
        const html = buildOfferPdfEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
        });

        // Customer-facing — Reply-To is the group inbox (Read B rule).
        return this.sendEmail({
            eventType: 'offer_sent_contact',
            to: opts.agentEmail,
            subject,
            html,
            replyTo: resolveReplyToFallback(),
            requestId: opts.requestId,
            proposalId: opts.proposalId,
            attachments: [
                {
                    filename: `Offer_${opts.referenceNumber}.pdf`,
                    content: opts.pdfBuffer,
                    contentType: 'application/pdf',
                },
            ],
        });
    }
}

export default new NotificationService();
