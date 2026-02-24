import webhookRepository from '../repositories/webhook.repository';

export class WebhookService {
    async processWebhook(payload: any, ip: string) {
        // Normalize fields as per instructions
        const normalizedData = {
            rawPayload: payload,
            externalRequestId: payload.RequestID || payload.id, // Example mapping
            source: 'webhook',
            sourceIp: ip,
            companyName: payload.CompanyName || payload.company_name,
            contactName: payload.ContactName || payload.contact_name,
            contactEmail: payload.ContactEmail || payload.contact_email,
            contactPhone: payload.ContactPhone || payload.contact_phone,
            destinationName: payload.DestinationName || payload.destination_name,
            destinationId: parseInt(payload.DestinationID || payload.destination_id || '0', 10),
            checkinDate: new Date(payload.CheckInDate || payload.checkin_date),
            nights: parseInt(payload.Nights || payload.nights || '0', 10),
            rooms: payload.Rooms || payload.rooms,
            nationalityCode: payload.NationalityCode || payload.nationality_code,
            budget: payload.Budget ? parseFloat(payload.Budget) : null,
            currencyCode: payload.CurrencyCode || payload.currency_code,
            specialRequirements: payload.SpecialRequirements || payload.special_requirements,
            status: 'pending',
        };

        const bookingRequest = await webhookRepository.createBookingRequest(normalizedData);

        // Process asynchronously (background job logic would go here)
        // For Phase-1, we just return the 200 fast.

        return bookingRequest;
    }
}

export default new WebhookService();
