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
export declare function logAuditEvent(params: AuditEventParams): Promise<void>;
export {};
