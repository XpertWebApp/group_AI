"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const notification_repository_1 = __importDefault(require("../repositories/notification.repository"));
const gmail_service_1 = __importDefault(require("./gmail.service"));
const logger_1 = __importDefault(require("../utils/logger"));
const emailTemplate_1 = require("./emailTemplate");
const emailErrors_1 = require("./email/emailErrors");
// ─── Email transport ──────────────────────────────────────────────────────────
function createTransport() {
    const host = process.env.SMTP_HOST;
    if (!host)
        return null;
    return nodemailer_1.default.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
    });
}
// ─── Service ──────────────────────────────────────────────────────────────────
class NotificationService {
    /**
     * Create an in-app notification record and optionally send an email.
     */
    async notify(opts) {
        // 1. In-app notification (DB)
        const data = {
            type: opts.type,
            title: opts.title,
            message: opts.message,
            entityId: opts.entityId,
            entityType: opts.entityType,
        };
        const notification = await notification_repository_1.default.create(data);
        // 2. Email
        if (opts.email) {
            await this.sendEmail(opts.email.to, opts.email.subject, opts.email.html);
        }
        return notification;
    }
    async sendEmail(to, subject, html) {
        const from = process.env.SMTP_FROM ?? 'noreply@sett.travel';
        const transport = createTransport();
        if (!transport) {
            logger_1.default.warn({ to, subject }, 'SMTP not configured — email not sent (set SMTP_HOST in .env)');
            return;
        }
        try {
            const info = await transport.sendMail({ from, to, subject, html });
            logger_1.default.info({ messageId: info.messageId, to, subject }, 'Email sent');
        }
        catch (err) {
            logger_1.default.error({ err, to, subject }, 'Failed to send email');
        }
    }
    /**
     * Notify staff that a new AI-generated offer is ready for review.
     */
    async notifyNewOfferReady(opts) {
        const title = `New group offer ready for review`;
        const message = `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}) has been generated and is ready for staff review.`;
        const emailHtml = (0, emailTemplate_1.buildOfferReadyEmail)({
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
    async notifyOfferGenerationFailed(opts) {
        const title = `Offer generation failed — manual action required`;
        const emailHtml = (0, emailTemplate_1.buildOfferGenerationFailedEmail)({
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
    async notifyInsufficientInventory(opts) {
        const title = `Insufficient inventory — manual action required`;
        const message = `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}): ` +
            `only ${opts.roomsFound} of ${opts.roomsNeeded} rooms found across ${opts.hotelsAccepted} hotel(s). ` +
            `${opts.roomsMissing} rooms short. Suggestion: ${opts.suggestion}`;
        const emailHtml = (0, emailTemplate_1.buildInsufficientInventoryEmail)({
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
    async notifyOfferApproved(opts) {
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
    async notifyOfferDeclined(opts) {
        const title = `Offer #${opts.referenceNumber} declined — manual action required`;
        const message = `Offer #${opts.referenceNumber} for ${opts.contactName} (${opts.destinationName}) has been declined. ` +
            `Reason: ${opts.rejectionReason}`;
        const emailHtml = (0, emailTemplate_1.buildOfferDeclinedEmail)({
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
    async sendEmailWithFallback(opts) {
        let primary = null;
        // Try Gmail first if we have a userId
        if (opts.userId) {
            primary = await gmail_service_1.default.sendEmail(opts.userId, {
                to: opts.to,
                subject: opts.subject,
                html: opts.html,
                attachments: opts.attachments,
            });
            if (primary.ok) {
                return primary;
            }
            logger_1.default.info({ to: opts.to, code: primary.failure.code }, 'Gmail send failed — considering SMTP fallback');
        }
        // Skip SMTP fallback for failures that require user action — SMTP can't fix
        // those, and falling back would mask the real reason from the caller.
        const SKIP_SMTP_FOR = new Set([
            emailErrors_1.EmailFailureCode.NOT_CONNECTED,
            emailErrors_1.EmailFailureCode.TOKEN_DECRYPT_FAILED,
            emailErrors_1.EmailFailureCode.TOKEN_REVOKED,
            emailErrors_1.EmailFailureCode.GMAIL_UNAUTHORIZED,
            emailErrors_1.EmailFailureCode.GMAIL_FORBIDDEN,
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
                logger_1.default.warn({ to: opts.to, code: primary.failure.code }, 'SMTP not configured — surfacing Gmail failure');
                return primary;
            }
            logger_1.default.warn({ to: opts.to, subject: opts.subject }, 'SMTP not configured — email not sent');
            return { ok: false, method: 'none', failure: (0, emailErrors_1.failure)('SMTP_NOT_CONFIGURED') };
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
            logger_1.default.info({ to: opts.to, subject: opts.subject, method: 'smtp' }, 'Email sent via SMTP');
            return { ok: true, method: 'smtp' };
        }
        catch (err) {
            logger_1.default.error({ err, to: opts.to, subject: opts.subject }, 'SMTP send failed');
            return {
                ok: false,
                method: 'smtp',
                failure: (0, emailErrors_1.failure)('SMTP_FAILED', { detail: err?.message }),
            };
        }
    }
    /**
     * Send approved offer PDF to agent via email.
     * Returns the underlying EmailSendResult so callers can inspect the failure code.
     */
    async sendOfferPdfToAgent(opts) {
        const subject = `Your Group Offer #${opts.referenceNumber} — ${opts.destinationName}`;
        const html = (0, emailTemplate_1.buildOfferPdfEmail)({
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
exports.NotificationService = NotificationService;
exports.default = new NotificationService();
