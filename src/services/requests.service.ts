import requestRepository from '../repositories/request.repository';
import { logAuditEvent } from '../utils/audit';
import { BookingRequestStatus } from '@prisma/client';
import type { ListRequestsOptions } from '../repositories/request.repository';

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

            // Assign to the logged-in user (for Gmail sending)
            assignedUserId: userId ?? null,

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
            'destinationId', 'destinationName', 'starRating', 'budgetRange',
            'budget', 'groupType', 'groupSize', 'averageAge', 'currencyCode', 'nationalityCode',
        ]) {
            if (data[f] !== undefined) updateData[f] = data[f];
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
            'guestListFileKey', 'customerNotes',
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

        // Step 4 – Policies
        for (const f of ['termsAndConditions', 'cancellationConditions']) {
            if (data[f] !== undefined) updateData[f] = data[f];
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
        return requestRepository.updateStatus(id, status as BookingRequestStatus);
    }
}

export default new RequestService();
