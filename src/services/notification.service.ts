import nodemailer from 'nodemailer';
import notificationRepository, { CreateNotificationData } from '../repositories/notification.repository';
import logger from '../utils/logger';

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

        const emailHtml = `
<h2>New Group Offer Ready for Review</h2>
<p>A new AI-generated group offer is ready for your review:</p>
<ul>
  <li><strong>Reference:</strong> #${opts.referenceNumber}</li>
  <li><strong>Client:</strong> ${opts.contactName}</li>
  <li><strong>Destination:</strong> ${opts.destinationName}</li>
</ul>
<p>Please log in to the SETT dashboard to review and finalise the offer.</p>
`.trim();

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
    }) {
        await this.notify({
            type: 'offer_generation_failed',
            title: `Offer generation failed — manual action required`,
            message: `Offer #${opts.referenceNumber} could not be generated automatically. Reason: ${opts.reason}. Please handle manually.`,
            entityId: opts.requestId,
            entityType: 'booking_request',
        });
    }
}

export default new NotificationService();
