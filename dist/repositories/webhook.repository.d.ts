import { BookingRequest } from '@prisma/client';
export declare class WebhookRepository {
    createBookingRequest(data: any): Promise<BookingRequest>;
    findById(id: string): Promise<BookingRequest | null>;
}
declare const _default: WebhookRepository;
export default _default;
