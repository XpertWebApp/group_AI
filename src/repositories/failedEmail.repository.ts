import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface RecordFailedEmailInput {
    eventType: string;
    recipient: string;
    subject: string;
    body: string;
    replyTo?: string | null;
    requestId?: string | null;
    proposalId?: string | null;
    attempts: number;
    lastError: string;
}

/**
 * Repository for the dead-letter email queue.
 *
 * Phase 1 scope: write rows + read for visibility. No automatic background re-attempt
 * (manual replay would require an admin UI which is out of scope).
 */
export class FailedEmailRepository {
    /** Persist an email that exhausted its retry budget. */
    async record(data: RecordFailedEmailInput) {
        return prisma.failedEmail.create({
            data: {
                eventType: data.eventType,
                recipient: data.recipient,
                subject: data.subject,
                body: data.body,
                replyTo: data.replyTo ?? null,
                requestId: data.requestId ?? null,
                proposalId: data.proposalId ?? null,
                attempts: data.attempts,
                lastError: data.lastError,
                lastAttemptAt: new Date(),
            },
            select: { id: true, eventType: true, recipient: true, attempts: true, createdAt: true },
        });
    }

    /** Mark a previously-failed email as resolved (e.g. after successful manual resend). */
    async markResolved(id: string) {
        return prisma.failedEmail.update({
            where: { id },
            data: { resolvedAt: new Date() },
        });
    }

    /** List unresolved failed emails (newest first). For audit/debug only — Phase 1 has no admin UI. */
    async listUnresolved(limit = 100) {
        return prisma.failedEmail.findMany({
            where: { resolvedAt: null },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }

    /** Count unresolved failed emails — useful for monitoring dashboards. */
    async countUnresolved() {
        return prisma.failedEmail.count({ where: { resolvedAt: null } });
    }
}

export default new FailedEmailRepository();
