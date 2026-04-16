"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAuditEvent = logAuditEvent;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
/**
 * Logs an audit event to the audit_events table.
 * Safe to call inside or outside a Prisma transaction.
 * Errors are swallowed so they never break the main flow.
 */
async function logAuditEvent(params) {
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
    }
    catch (err) {
        // Audit failures must not crash the main request
        console.error('[audit] Failed to write audit event', err);
    }
}
