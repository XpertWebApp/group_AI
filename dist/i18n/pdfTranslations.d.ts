/**
 * PDF Translation Dictionary — EN / DE
 *
 * Contains all static labels, headings, and fixed text used in the offer PDF.
 * Dynamic user-entered content (notes, special requirements) is translated
 * via the Google Translate API at runtime — see translation.service.ts.
 */
export type PdfLanguage = 'en' | 'de';
export interface PdfTranslations {
    taxId: string;
    contract: string;
    preparedFor: string;
    tripDetails: string;
    hotelDetails: string;
    serviceDetails: string;
    serviceNotes: string;
    cancellationConditions: string;
    termsAndConditions: string;
    issuedBy: string;
    assignedPerson: string;
    phoneNumber: string;
    website: string;
    emailAddress: string;
    address: string;
    companyId: string;
    documentCode: string;
    createdDate: string;
    customerPerson: string;
    destination: string;
    checkinOut: string;
    guests: string;
    destinationCol: string;
    rate: string;
    qty: string;
    nights: string;
    total: string;
    subtotal: string;
    referenceNumber: string;
    disclaimerNoReservation: string;
    disclaimerCityTax: string;
    totalLabel: string;
    paymentPrefix: string;
    paymentUntil: string;
    mealBreakfast: string;
    mealHalfBoard: string;
    mealFullBoard: string;
    mealAllInclusive: string;
    mealRoomOnly: string;
}
/**
 * Returns the full PDF translation object for the given language.
 * Defaults to English if the language is not supported.
 */
export declare function getPdfTranslations(lang: PdfLanguage): PdfTranslations;
