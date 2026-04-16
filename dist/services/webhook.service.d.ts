/**
 * Webhook Service
 *
 * Handles inbound payloads from the SETT website Wix form:
 *   https://www.s-e-t-t.com/_api/form-submission-service/v4/submissions
 *   formId: cdd7652b-be36-4756-a985-9e390fa1477e
 *
 * Flow:
 *   1. Validate formId and required fields
 *   2. Map Wix form fields → BookingRequest schema
 *   3. Resolve destinationId by name from master.destinations
 *   4. Save booking request with status: pending
 *   5. Trigger async offer generation (background, non-blocking)
 */
export declare class WebhookService {
    processWebhook(payload: any, ip: string): Promise<{
        id: string;
        referenceNumber: any;
        status: import(".prisma/client").$Enums.BookingRequestStatus;
        destinationName: string;
        message: string;
    }>;
}
declare const _default: WebhookService;
export default _default;
