import requestRepository from '../repositories/request.repository';
import { logAuditEvent } from '../utils/audit';
import { BookingRequestStatus } from '@prisma/client';

export class RequestService {
    async getAllRequests() {
        return requestRepository.findAll();
    }

    async getRequestById(id: string) {
        const request = await requestRepository.findById(id);
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
        const payload = {
            source: data.source ?? 'ui',
            companyName: data.companyName,
            contactName: data.contactName,
            contactEmail: data.contactEmail,
            contactPhone: data.contactPhone,
            currencyCode: data.currencyCode,
            destinationId: data.destinationId,
            destinationName: data.destinationName,
            checkinDate: new Date(data.checkinDate),
            nights: data.nights,
            rooms: data.rooms,
            nationalityCode: data.nationalityCode ?? null,
            budget: data.budget ?? null,
            specialRequirements: data.specialRequirements ?? null,
            status: (data.status as BookingRequestStatus) ?? BookingRequestStatus.pending,
            rawPayload: data,
        };

        const request = await requestRepository.create(payload as any);

        await logAuditEvent({
            userId,
            action: 'create_request',
            entity: 'booking_request',
            entityId: request.id,
            details: { companyName: data.companyName, destinationName: data.destinationName },
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
        const allowedFields = [
            'companyName', 'contactName', 'contactEmail', 'contactPhone',
            'currencyCode', 'destinationId', 'destinationName', 'nights',
            'rooms', 'nationalityCode', 'budget', 'specialRequirements', 'source',
        ];

        for (const field of allowedFields) {
            if (data[field] !== undefined) updateData[field] = data[field];
        }
        if (data.checkinDate) updateData.checkinDate = new Date(data.checkinDate);
        if (data.status) updateData.status = data.status as BookingRequestStatus;

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
