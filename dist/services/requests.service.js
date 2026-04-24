"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestService = void 0;
const request_repository_1 = __importDefault(require("../repositories/request.repository"));
const audit_1 = require("../utils/audit");
const client_1 = require("@prisma/client");
/** Derive nights (integer days) from ISO date strings. */
function calcNights(checkin, checkout) {
    return Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86400000);
}
class RequestService {
    async getAllRequests(opts = {}) {
        return request_repository_1.default.findAll(opts);
    }
    async getRequestById(id) {
        const request = await request_repository_1.default.findById(id);
        if (!request) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        return request;
    }
    async getRequestByRef(ref) {
        const request = await request_repository_1.default.findByReferenceNumber(ref);
        if (!request) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        return request;
    }
    async getSummary(id) {
        const request = await request_repository_1.default.findSummary(id);
        if (!request) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        return request;
    }
    async createRequest(data, userId, ip) {
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
            budgetRange: data.budgetRange ?? null,
            budget: data.budget ?? null,
            groupType: data.groupType ?? null,
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
            // Step 4 – Policies
            termsAndConditions: data.termsAndConditions ?? null,
            cancellationConditions: data.cancellationConditions ?? null,
            // Ownership starts unassigned — creating a request is not an owning action.
            // Ownership is claimed on the first add/remove hotel, add/remove service,
            // send, or decline (see proposals.service.ts::claimForRequest).
            assignedUserId: null,
            status: data.status ?? client_1.BookingRequestStatus.pending,
        };
        const request = await request_repository_1.default.create(payload);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'create_request',
            entity: 'booking_request',
            entityId: request.id,
            details: {
                referenceNumber: request.referenceNumber,
                companyName: data.companyName,
                destinationName: data.destinationName,
            },
            ipAddress: ip,
        });
        return request;
    }
    async updateRequest(id, data, userId) {
        const existing = await request_repository_1.default.findById(id);
        if (!existing) {
            throw { status: 404, message: 'Request not found', code: 'NOT_FOUND' };
        }
        const updateData = {};
        // Step 1 – Trip Details
        for (const f of [
            'destinationId', 'destinationName', 'starRating', 'budgetRange',
            'budget', 'groupType', 'groupSize', 'averageAge', 'currencyCode', 'nationalityCode',
        ]) {
            if (data[f] !== undefined)
                updateData[f] = data[f];
        }
        // Dates — recalculate nights if either date changes
        const newCheckin = data.checkinDate ? new Date(data.checkinDate) : undefined;
        const newCheckout = data.checkoutDate ? new Date(data.checkoutDate) : undefined;
        if (newCheckin)
            updateData.checkinDate = newCheckin;
        if (newCheckout)
            updateData.checkoutDate = newCheckout;
        if (data.nights !== undefined) {
            updateData.nights = data.nights;
        }
        else if (newCheckin || newCheckout) {
            const cin = (newCheckin ?? existing.checkinDate).toISOString();
            const cout = (newCheckout ?? existing.checkoutDate)?.toISOString();
            if (cin && cout)
                updateData.nights = calcNights(cin, cout);
        }
        // Step 2 – Room & Accommodations
        for (const f of ['rooms', 'breakfastPreference', 'hotelLocation', 'specialRequirements']) {
            if (data[f] !== undefined)
                updateData[f] = data[f];
        }
        // Step 3 – Customer Details
        for (const f of [
            'companyName', 'firstName', 'lastName',
            'contactEmail', 'contactPhone', 'contactPhoneCountryCode',
            'guestListFileKey', 'customerNotes',
        ]) {
            if (data[f] !== undefined)
                updateData[f] = data[f];
        }
        // Keep contactName in sync with firstName/lastName
        if (data.firstName !== undefined || data.lastName !== undefined) {
            const fn = data.firstName ?? existing.firstName ?? '';
            const ln = data.lastName ?? existing.lastName ?? '';
            updateData.contactName = [fn, ln].filter(Boolean).join(' ') || null;
        }
        else if (data.contactName !== undefined) {
            updateData.contactName = data.contactName;
        }
        // Step 4 – Policies
        for (const f of ['termsAndConditions', 'cancellationConditions']) {
            if (data[f] !== undefined)
                updateData[f] = data[f];
        }
        if (data.status)
            updateData.status = data.status;
        if (data.source)
            updateData.source = data.source;
        updateData.rawPayload = { ...(existing.rawPayload ?? {}), ...data };
        const updated = await request_repository_1.default.update(id, updateData);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'update_request',
            entity: 'booking_request',
            entityId: id,
            details: { fields: Object.keys(updateData) },
        });
        return updated;
    }
    async updateRequestStatus(id, status) {
        return request_repository_1.default.updateStatus(id, status);
    }
    /**
     * Claim ownership of a booking request if currently unassigned.
     * Idempotent: no-op if already claimed. Audit-logs only on the winning claim.
     * Never throws — callers can fire-and-forget (e.g. from middleware).
     *
     * @param trigger 'auto' for first-action middleware, 'explicit' for /claim endpoint
     */
    async claimOwnershipIfUnassigned(requestId, userId, ip, trigger = 'auto') {
        if (!requestId || !userId)
            return { claimed: false, ownerId: null };
        try {
            const result = await request_repository_1.default.claimOwnershipIfUnassigned(requestId, userId);
            if (result.claimed) {
                await (0, audit_1.logAuditEvent)({
                    userId,
                    action: 'claim_ownership',
                    entity: 'booking_request',
                    entityId: requestId,
                    details: { trigger },
                    ipAddress: ip,
                });
            }
            return result;
        }
        catch {
            return { claimed: false, ownerId: null };
        }
    }
}
exports.RequestService = RequestService;
exports.default = new RequestService();
