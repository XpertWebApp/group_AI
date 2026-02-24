import prisma from './prisma';
import logger from './logger';

interface AuditEventParams {
    userId?: string | null;
    action: string;
    entity?: string;
    entityId?: string;
    details?: Record<string, any>;
    ipAddress?: string;
}

/**
 * Logs an audit event to the audit_events table.
 * Safe to call inside or outside a Prisma transaction.
 * Errors are swallowed so they never break the main flow.
 */
export async function logAuditEvent(params: AuditEventParams): Promise<void> {
    try {
        await prisma.auditEvent.create({
            data: {
                userId: params.userId ?? null,
                action: params.action,
                entity: params.entity ?? null,
                entityId: params.entityId ?? null,
                details: params.details ?? undefined,
                ipAddress: params.ipAddress ?? null,
            },
        });
    } catch (err) {
        // Audit failures must not crash the main request
        logger.error({ err }, 'Failed to write audit event');
    }
}
