import nodemailer from 'nodemailer';
import notificationRepository, { CreateNotificationData } from '../repositories/notification.repository';
import gmailService from './gmail.service';
import logger from '../utils/logger';
import {
    buildOfferReadyEmail,
    buildInsufficientInventoryEmail,
    buildOfferDeclinedEmail,
    buildOfferPdfEmail,
    buildOfferGenerationFailedEmail,
} from './emailTemplate';
import { EmailFailureCode, EmailSendResult, failure } from './email/emailErrors';

// ─── Email transport ──────────────────────────────────────────────────────────

function createTransport() {
    const host = process.env.SMTP_HOST;
    if (!host) return null;

    return nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
    });
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class NotificationService {
    /**
     * Create an in-app notification record and optionally send an email.
     */
    async notify(opts: {
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
    }) {
        // 1. In-app notification (DB)
        const data: CreateNotificationData = {
            type: opts.type,
            title: opts.title,
            message: opts.message,
            entityId: opts.entityId,
            entityType: opts.entityType,
        };
        const notification = await notificationRepository.create(data);

        // 2. Email
        if (opts.email) {
            await this.sendEmail(opts.email.to, opts.email.subject, opts.email.html);
        }

        return notification;
    }

    async sendEmail(to: string, subject: string, html: string) {
        const from = process.env.SMTP_FROM ?? 'noreply@sett.travel';
        const transport = createTransport();

        if (!transport) {
            logger.warn({ to, subject }, 'SMTP not configured — email not sent (set SMTP_HOST in .env)');
            return;
        }

        try {
            const info = await transport.sendMail({ from, to, subject, html });
            logger.info({ messageId: info.messageId, to, subject }, 'Email sent');
        } catch (err) {
            logger.error({ err, to, subject }, 'Failed to send email');
        }
    }

    /**
     * Notify staff that a new AI-generated offer is ready for review.
     */
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
        });

        await this.notify({
            type: 'new_offer_ready',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      to: opts.staffEmail,
                      subject: title,
                      html: emailHtml,
                  }
                : undefined,
        });
    }

    /**
     * Notify staff that offer generation failed so they can handle it manually.
     */
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
        });

        await this.notify({
            type: 'offer_generation_failed',
            title,
            message: `Offer #${opts.referenceNumber} could not be generated automatically. Reason: ${opts.reason}. Please handle manually.`,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? { to: opts.staffEmail, subject: title, html: emailHtml }
                : undefined,
        });
    }

    /**
     * Escalate to human when the accumulation gate cannot meet the room target.
     * A partial offer is still created with whatever hotels were accepted.
     * Staff are notified with the shortfall details and a suggested action.
     */
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
            roomsNeeded: opts.roomsNeeded,
            roomsFound: opts.roomsFound,
            roomsMissing: opts.roomsMissing,
            hotelsAccepted: opts.hotelsAccepted,
            suggestion: opts.suggestion,
        });

        await this.notify({
            type: 'insufficient_inventory',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      to: opts.staffEmail,
                      subject: `Offer #${opts.referenceNumber} — ${opts.roomsMissing} rooms short, manual action needed`,
                      html: emailHtml,
                  }
                : undefined,
        });
    }

    /**
     * Notify staff that an offer has been approved and PDF sent to agent.
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
        const message = `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}) has been approved and the PDF has been sent to the agent.`;

        await this.notify({
            type: 'offer_approved',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
        });
    }

    /**
     * Notify staff that an offer has been rejected.
     * Sends both in-app notification and email.
     */
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
        });

        await this.notify({
            type: 'offer_declined',
            title,
            message,
            entityId: opts.requestId,
            entityType: 'booking_request',
            email: opts.staffEmail
                ? {
                      to: opts.staffEmail,
                      subject: `Offer #${opts.referenceNumber} declined — ${opts.rejectionReason}`,
                      html: emailHtml,
                  }
                : undefined,
        });
    }

    /**
     * Send an email via Gmail API (if userId provided and connected), otherwise SMTP.
     * Returns an `EmailSendResult` discriminated union.
     *
     * On Gmail failures that require user action (NOT_CONNECTED, TOKEN_REVOKED,
     * GMAIL_FORBIDDEN, etc.), this method does NOT fall back to SMTP — those errors
     * wouldn't be solved by SMTP and we want the real cause surfaced to the caller.
     * For other Gmail failures (network, upstream 5xx), SMTP fallback is attempted.
     */
    async sendEmailWithFallback(opts: {
        userId?: string;
        to: string;
        subject: string;
        html: string;
        attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
    }): Promise<EmailSendResult> {
        let primary: EmailSendResult | null = null;

        // Try Gmail first if we have a userId
        if (opts.userId) {
            primary = await gmailService.sendEmail(opts.userId, {
                to: opts.to,
                subject: opts.subject,
                html: opts.html,
                attachments: opts.attachments,
            });
            if (primary.ok) {
                return primary;
            }
            logger.info(
                { to: opts.to, code: primary.failure.code },
                'Gmail send failed — considering SMTP fallback',
            );
        }

        // Skip SMTP fallback for failures that require user action — SMTP can't fix
        // those, and falling back would mask the real reason from the caller.
        const SKIP_SMTP_FOR: ReadonlySet<EmailFailureCode> = new Set<EmailFailureCode>([
            EmailFailureCode.NOT_CONNECTED,
            EmailFailureCode.TOKEN_DECRYPT_FAILED,
            EmailFailureCode.TOKEN_REVOKED,
            EmailFailureCode.GMAIL_UNAUTHORIZED,
            EmailFailureCode.GMAIL_FORBIDDEN,
        ]);
        if (primary && !primary.ok && SKIP_SMTP_FOR.has(primary.failure.code)) {
            return primary;
        }

        // Fallback to SMTP
        const transport = createTransport();
        if (!transport) {
            // No SMTP configured. If Gmail also failed, prefer Gmail's specific reason;
            // otherwise return SMTP_NOT_CONFIGURED.
            if (primary && !primary.ok) {
                logger.warn({ to: opts.to, code: primary.failure.code }, 'SMTP not configured — surfacing Gmail failure');
                return primary;
            }
            logger.warn({ to: opts.to, subject: opts.subject }, 'SMTP not configured — email not sent');
            return { ok: false, method: 'none', failure: failure('SMTP_NOT_CONFIGURED') };
        }

        const from = process.env.SMTP_FROM ?? 'noreply@sett.travel';
        try {
            await transport.sendMail({
                from,
                to: opts.to,
                subject: opts.subject,
                html: opts.html,
                attachments: opts.attachments?.map((a) => ({
                    filename: a.filename,
                    content: a.content,
                    contentType: a.contentType,
                })),
            });
            logger.info({ to: opts.to, subject: opts.subject, method: 'smtp' }, 'Email sent via SMTP');
            return { ok: true, method: 'smtp' };
        } catch (err: any) {
            logger.error({ err, to: opts.to, subject: opts.subject }, 'SMTP send failed');
            return {
                ok: false,
                method: 'smtp',
                failure: failure('SMTP_FAILED', { detail: err?.message }),
            };
        }
    }

    /**
     * Send approved offer PDF to agent via email.
     * Returns the underlying EmailSendResult so callers can inspect the failure code.
     */
    async sendOfferPdfToAgent(opts: {
        agentEmail: string;
        referenceNumber: number;
        contactName: string;
        destinationName: string;
        pdfBuffer: Buffer;
        userId?: string;
    }): Promise<EmailSendResult> {
        const subject = `Your Group Offer #${opts.referenceNumber} — ${opts.destinationName}`;
        const html = buildOfferPdfEmail({
            referenceNumber: opts.referenceNumber,
            contactName: opts.contactName,
            destinationName: opts.destinationName,
        });

        return this.sendEmailWithFallback({
            userId: opts.userId,
            to: opts.agentEmail,
            subject,
            html,
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
