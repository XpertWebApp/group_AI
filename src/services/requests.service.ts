import requestRepository from '../repositories/request.repository';
import notificationService, { resolveStaffNotificationEmail } from './notification.service';
import { parseGroupType } from './webhook.service';
import { logAuditEvent } from '../utils/audit';
import logger from '../utils/logger';
import { BookingRequestStatus } from '@prisma/client';
import type { ListRequestsOptions } from '../repositories/request.repository';
import { translateTextsFree } from '../utils/freeTranslate';

/**
 * Auto-translate the per-offer policy overrides (rich-text HTML) to German via
 * the free translator, so the FE/PDF can show them under the DE locale without
 * manual authoring. Empty base → null (FE falls back to the base field).
 * Both fields go through a single batched call. On translator failure the
 * helper returns the originals; we treat an unchanged string as "no German
 * available" and store null so the FE degrades cleanly to English.
 */
async function translatePoliciesToDe(
    terms: string | null | undefined,
    cancellation: string | null | undefined,
): Promise<{ termsAndConditionsDe: string | null; cancellationConditionsDe: string | null }> {
    const t = terms?.trim() ? terms : null;
    const c = cancellation?.trim() ? cancellation : null;
    if (!t && !c) return { termsAndConditionsDe: null, cancellationConditionsDe: null };

    const inputs: string[] = [];
    if (t) inputs.push(t);
    if (c) inputs.push(c);
    const out = await translateTextsFree(inputs, 'en', 'de');

    let i = 0;
    const pick = (src: string | null): string | null => {
        if (!src) return null;
        const translated = out[i++];
        // Unchanged === translator failed/returned original → store null so the
        // FE shows the English base rather than a stale duplicate.
        return translated && translated !== src ? translated : null;
    };
    return { termsAndConditionsDe: pick(t), cancellationConditionsDe: pick(c) };
}

/**
 * Comma-separated list of BookingRequestStatus transitions that fire a status-change
 * email to staff. Read once at module load. Adding/removing a transition is a config
 * change in `.env` (`NOTIFY_STATUS_TRANSITIONS=sent,completed,cancelled`) — no code change.
 */
const NOTIFY_STATUS_TRANSITIONS = new Set(
    (process.env.NOTIFY_STATUS_TRANSITIONS ?? 'sent,completed,cancelled')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
);

/** Derive nights (integer days) from ISO date strings. */
function calcNights(checkin: string, checkout: string): number {
    return Math.round(
        (new Date(checkout).getTime() - new Date(checkin).getTime()) / 86_400_000,
    );
}

export class RequestService {
    async getAllRequests(opts: ListRequestsOptions = {}) {
        return requestRepository.findAll(opts);
    }

    async getRequestById(id: string) {
        const request = await requestRepository.findById(id);
        if (!request) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        return request;
    }

    async getRequestByRef(ref: number) {
        const request = await requestRepository.findByReferenceNumber(ref);
        if (!request) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        return request;
    }

    async getSummary(id: string) {
        const request = await requestRepository.findSummary(id);
        if (!request) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        return request;
    }

    async createRequest(data: any, userId?: string, ip?: string) {
        // Derive nights from checkinDate + checkoutDate when checkoutDate is provided
        let nights = data.nights;
        if (!nights && data.checkoutDate) {
            nights = calcNights(data.checkinDate, data.checkoutDate);
        }
        if (!nights || nights < 1) {
            throw {
                status: 400,
                message: 'Cannot determine stay length: provide nights or a valid checkoutDate',
                code: 'INVALID_NIGHTS',
            };
        }

        // Build contactName for backward compatibility (firstName + lastName)
        const derivedName = [data.firstName, data.lastName].filter(Boolean).join(' ');
        const contactName = data.contactName ?? (derivedName || undefined);

        const payload = {
            source: data.source ?? 'ui',
            rawPayload: data,

            // Step 1 – Trip Details
            destinationId: data.destinationId,
            destinationName: data.destinationName,
            checkinDate: new Date(data.checkinDate),
            checkoutDate: data.checkoutDate ? new Date(data.checkoutDate) : undefined,
            nights,
            starRating: data.starRating ?? null,
            // Multi-select star categories — accepted from the FE as
            // `starRatings: number[]`. Falls back to wrapping the legacy
            // single `starRating` when only that was sent (Wix webhook,
            // older FE builds). Default is [] = "any star rating".
            starRatings: Array.isArray(data.starRatings) && data.starRatings.length > 0
                ? data.starRatings
                : (data.starRating != null ? [data.starRating] : []),
            budgetRange: data.budgetRange ?? null,
            budget: data.budget ?? null,
            groupType: parseGroupType(data.groupType),
            groupSize: data.groupSize ?? null,
            averageAge: data.averageAge ?? null,
            currencyCode: data.currencyCode ?? 'EUR',
            nationalityCode: data.nationalityCode ?? null,

            // Step 2 – Room & Accommodations
            rooms: data.rooms ?? null,
            breakfastPreference: data.breakfastPreference ?? null,
            hotelLocation: data.hotelLocation ?? null,
            specialRequirements: data.specialRequirements ?? null,

            // Step 3 – Customer Details
            companyName: data.companyName,
            firstName: data.firstName,
            lastName: data.lastName,
            contactName,
            contactEmail: data.contactEmail,
            contactPhone: data.contactPhone,
            contactPhoneCountryCode: data.contactPhoneCountryCode ?? null,
            guestListFileKey: data.guestListFileKey ?? null,
            customerNotes: data.customerNotes ?? null,
            // Odoo CRM link (optional at create — staff can fill it in later
            // via PATCH). The offer-send gate enforces this on requests
            // created on/after config.odoo.gateActiveSince.
            odooContactId: data.odooContactId ?? null,

            // Step 4 – Policies (+ free German auto-translation)
            termsAndConditions: data.termsAndConditions ?? null,
            cancellationConditions: data.cancellationConditions ?? null,
            ...(await translatePoliciesToDe(data.termsAndConditions, data.cancellationConditions)),

            // Ownership starts unassigned — creating a request is not an owning action.
            // Ownership is claimed on the first add/remove hotel, add/remove service,
            // send, or decline (see proposals.service.ts::claimForRequest).
            assignedUserId: null,

            status: (data.status as BookingRequestStatus) ?? BookingRequestStatus.pending,
        };

        const request = await requestRepository.create(payload as any);

        await logAuditEvent({
            userId,
            action: 'create_request',
            entity: 'booking_request',
            entityId: (request as any).id,
            details: {
                referenceNumber: (request as any).referenceNumber,
                companyName: data.companyName,
                destinationName: data.destinationName,
            },
            ipAddress: ip,
        });

        // Fire portal notifications (staff alert + customer confirmation). Fire-and-forget —
        // never block the create response on email delivery; notification.service handles
        // retry + dead-letter internally.
        const refNum = (request as any).referenceNumber;
        const reqId = (request as any).id;
        const displayName = contactName ?? data.companyName ?? 'Customer';
        const destName = data.destinationName ?? 'Unknown destination';
        const staffEmail = resolveStaffNotificationEmail();

        if (staffEmail) {
            void notificationService
                .notifyNewRequestStaff({
                    requestId: reqId,
                    referenceNumber: refNum,
                    contactName: displayName,
                    destinationName: destName,
                    source: 'portal',
                    staffEmail,
                    groupType: (request as any).groupType ?? data.groupType ?? null,
                    averageAge: (request as any).averageAge ?? data.averageAge ?? null,
                })
                .catch((err) => logger.warn({ err: err.message, reqId }, 'notifyNewRequestStaff failed'));
        }
        if (data.contactEmail) {
            void notificationService
                .notifyNewRequestContact({
                    requestId: reqId,
                    referenceNumber: refNum,
                    contactEmail: data.contactEmail,
                    contactName: displayName,
                    destinationName: destName,
                })
                .catch((err) => logger.warn({ err: err.message, reqId }, 'notifyNewRequestContact failed'));
        }

        return request;
    }

    async updateRequest(id: string, data: any, userId?: string) {
        const existing = await requestRepository.findById(id);
        if (!existing) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }

        const updateData: any = {};

        // Step 1 – Trip Details
        for (const f of [
            'destinationId', 'destinationName', 'starRating', 'starRatings', 'budgetRange',
            'budget', 'groupType', 'groupSize', 'averageAge', 'currencyCode', 'nationalityCode',
        ]) {
            if (data[f] !== undefined) updateData[f] = data[f];
        }

        // Normalise groupType to canonical code (German labels, casing variants, etc. → internal code)
        if (updateData.groupType !== undefined) {
            updateData.groupType = parseGroupType(updateData.groupType);
        }

        // Dates — recalculate nights if either date changes
        const newCheckin = data.checkinDate ? new Date(data.checkinDate) : undefined;
        const newCheckout = data.checkoutDate ? new Date(data.checkoutDate) : undefined;
        if (newCheckin) updateData.checkinDate = newCheckin;
        if (newCheckout) updateData.checkoutDate = newCheckout;

        if (data.nights !== undefined) {
            updateData.nights = data.nights;
        } else if (newCheckin || newCheckout) {
            const cin = (newCheckin ?? existing.checkinDate).toISOString();
            const cout = (newCheckout ?? (existing as any).checkoutDate)?.toISOString();
            if (cin && cout) updateData.nights = calcNights(cin, cout);
        }

        // Step 2 – Room & Accommodations
        for (const f of ['rooms', 'breakfastPreference', 'hotelLocation', 'specialRequirements']) {
            if (data[f] !== undefined) updateData[f] = data[f];
        }

        // Step 3 – Customer Details
        for (const f of [
            'companyName', 'firstName', 'lastName',
            'contactEmail', 'contactPhone', 'contactPhoneCountryCode',
            'guestListFileKey', 'customerNotes', 'odooContactId',
        ]) {
            if (data[f] !== undefined) updateData[f] = data[f];
        }

        // Keep contactName in sync with firstName/lastName
        if (data.firstName !== undefined || data.lastName !== undefined) {
            const fn = data.firstName ?? (existing as any).firstName ?? '';
            const ln = data.lastName ?? (existing as any).lastName ?? '';
            updateData.contactName = [fn, ln].filter(Boolean).join(' ') || null;
        } else if (data.contactName !== undefined) {
            updateData.contactName = data.contactName;
        }

        // Step 4 – Policies. Regenerate the German auto-translation whenever a
        // base policy field is edited (cleared → De also cleared).
        for (const f of ['termsAndConditions', 'cancellationConditions']) {
            if (data[f] !== undefined) updateData[f] = data[f];
        }
        if (data.termsAndConditions !== undefined || data.cancellationConditions !== undefined) {
            const nextTerms = data.termsAndConditions !== undefined
                ? data.termsAndConditions : (existing as any).termsAndConditions;
            const nextCxl = data.cancellationConditions !== undefined
                ? data.cancellationConditions : (existing as any).cancellationConditions;
            const de = await translatePoliciesToDe(nextTerms, nextCxl);
            if (data.termsAndConditions !== undefined) updateData.termsAndConditionsDe = de.termsAndConditionsDe;
            if (data.cancellationConditions !== undefined) updateData.cancellationConditionsDe = de.cancellationConditionsDe;
        }

        if (data.status) updateData.status = data.status as BookingRequestStatus;
        if (data.source) updateData.source = data.source;

        updateData.rawPayload = { ...((existing as any).rawPayload ?? {}), ...data };

        const updated = await requestRepository.update(id, updateData);

        await logAuditEvent({
            userId,
            action: 'update_request',
            entity: 'booking_request',
            entityId: id,
            details: { fields: Object.keys(updateData) },
        });

        return updated;
    }

    async updateRequestStatus(id: string, status: string) {
        // Capture previous status BEFORE the update so we can decide whether to email
        // and what to put in the "from" field. A missing previous-status row means the
        // request doesn't exist; let the update call surface the failure.
        const before = await requestRepository.findById(id).catch(() => null);
        const fromStatus = (before as any)?.status as string | undefined;

        const updated = await requestRepository.updateStatus(id, status as BookingRequestStatus);

        // Fire status-change email if the new state is in the configured trigger list
        // and we actually transitioned (not a no-op write).
        if (NOTIFY_STATUS_TRANSITIONS.has(status) && fromStatus && fromStatus !== status) {
            const staffEmail = resolveStaffNotificationEmail();
            if (staffEmail) {
                const full = (before as any) ?? {};
                const refNum = full.referenceNumber ?? 0;
                const displayName = full.contactName ?? full.companyName ?? full.firstName ?? 'Customer';
                const destName = full.destinationName ?? 'Unknown destination';
                void notificationService
                    .notifyStatusChange({
                        requestId: id,
                        referenceNumber: refNum,
                        contactName: displayName,
                        destinationName: destName,
                        fromStatus,
                        toStatus: status,
                        staffEmail,
                    })
                    .catch((err) => logger.warn({ err: err.message, id }, 'notifyStatusChange failed'));
            }
        }

        return updated;
    }

    /**
     * Claim ownership of a booking request if currently unassigned.
     * Idempotent: no-op if already claimed. Audit-logs only on the winning claim.
     * Never throws — callers can fire-and-forget (e.g. from middleware).
     *
     * @param trigger 'auto' for first-action middleware, 'explicit' for /claim endpoint
     */
    async claimOwnershipIfUnassigned(
        requestId: string,
        userId: string,
        ip?: string,
        trigger: 'auto' | 'explicit' = 'auto',
    ): Promise<{ claimed: boolean; ownerId: string | null }> {
        if (!requestId || !userId) return { claimed: false, ownerId: null };
        try {
            const result = await requestRepository.claimOwnershipIfUnassigned(requestId, userId);
            if (result.claimed) {
                await logAuditEvent({
                    userId,
                    action: 'claim_ownership',
                    entity: 'booking_request',
                    entityId: requestId,
                    details: { trigger },
                    ipAddress: ip,
                });
            }
            return result;
        } catch {
            return { claimed: false, ownerId: null };
        }
    }
}

export default new RequestService();
