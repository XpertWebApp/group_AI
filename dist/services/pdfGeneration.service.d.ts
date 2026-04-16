/**
 * PDF Generation Service — Demo Placeholder
 *
 * NOTE: The full quotation PDF design is part of Milestone 5 and is not
 * implemented in this milestone. This file generates a simple placeholder
 * PDF to indicate that the feature is coming soon. The full Figma-matched
 * design will be delivered in Milestone 5.
 *
 * The exported types (`OfferPdfData`, `OfferHotel`, `OfferService`) and the
 * `generateOfferPdf` function signature are kept intact so the rest of the
 * application (proposals service, controller, email attachments) continues
 * to work without changes.
 */
export interface OfferHotel {
    hotelName: string;
    starRating: number | null;
    addressCity: string | null;
    addressCountry: string | null;
    roomType: string;
    roomQty: number;
    mealPlan: string;
    pricePerRoomPerNight: number;
    totalPrice: number;
    cancelDeadline: string | null;
}
export interface OfferService {
    serviceName: string;
    quantity: number;
    days: number;
    unitPrice: number;
    totalPrice: number;
}
export interface OfferPdfData {
    companyName: string;
    companyAddress: string;
    companyPhone: string;
    companyPhoneCountryCode?: string | null;
    companyEmail: string;
    companyWebsite: string;
    companyTaxId: string;
    assignedPerson: string;
    referenceNumber: number;
    contactName: string;
    companyNameClient: string;
    contactEmail: string;
    contactPhone: string;
    contactPhoneCountryCode?: string | null;
    destinationName: string;
    checkinDate: string;
    checkoutDate: string;
    nights: number;
    hotels: OfferHotel[];
    services: OfferService[];
    specialRequirements: string | null;
    customerNotes: string | null;
    cancellationConditions: string | null;
    termsAndConditions: string | null;
    currency: string;
    totalPrice: number;
    sellingPricePerRoomPerNight: number;
    totalRooms: number;
}
export declare function generateOfferPdf(data: OfferPdfData): Promise<Buffer>;
