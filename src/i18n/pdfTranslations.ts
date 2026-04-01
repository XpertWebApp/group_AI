/**
 * PDF Translation Dictionary — EN / DE
 *
 * Contains all static labels, headings, and fixed text used in the offer PDF.
 * Dynamic user-entered content (notes, special requirements) is translated
 * via the Google Translate API at runtime — see translation.service.ts.
 */
export type PdfLanguage = 'en' | 'de';

export interface PdfTranslations {
    // Header
    taxId: string;

    // Section headings
    contract: string;
    preparedFor: string;
    tripDetails: string;
    hotelDetails: string;
    serviceDetails: string;
    serviceNotes: string;
    cancellationConditions: string;
    termsAndConditions: string;
    issuedBy: string;

    // Company info labels
    assignedPerson: string;
    phoneNumber: string;
    website: string;
    emailAddress: string;
    address: string;

    // Contract labels
    companyId: string;
    documentCode: string;
    createdDate: string;

    // Prepared for labels
    customerPerson: string;

    // Trip detail labels
    destination: string;
    checkinOut: string;
    guests: string;

    // Hotel table headers
    destinationCol: string;
    rate: string;
    qty: string;
    nights: string;
    total: string;
    subtotal: string;
    referenceNumber: string;

    // Service notes (fixed disclaimer text)
    disclaimerNoReservation: string;
    disclaimerCityTax: string;

    // Total bar
    totalLabel: string;

    // Terms payment callout
    paymentPrefix: string;
    paymentUntil: string;

    // Meal plans
    mealBreakfast: string;
    mealHalfBoard: string;
    mealFullBoard: string;
    mealAllInclusive: string;
    mealRoomOnly: string;
}

const en: PdfTranslations = {
    // Header
    taxId: 'TAX ID',

    // Section headings
    contract: 'Contract',
    preparedFor: 'Prepared For',
    tripDetails: 'Trip Details',
    hotelDetails: 'Hotel Details',
    serviceDetails: 'Service Details',
    serviceNotes: 'Service Notes',
    cancellationConditions: 'Cancellation Conditions',
    termsAndConditions: 'Terms & Conditions',
    issuedBy: 'ISSUED BY',

    // Company info labels
    assignedPerson: 'Assigned Person',
    phoneNumber: 'Phone Number',
    website: 'Website',
    emailAddress: 'Email Address',
    address: 'Address',

    // Contract labels
    companyId: 'Company ID',
    documentCode: 'Document Code',
    createdDate: 'Created Date',

    // Prepared for labels
    customerPerson: 'Customer Person',

    // Trip detail labels
    destination: 'Destination',
    checkinOut: 'Checkin/Out',
    guests: 'Guests',

    // Hotel table headers
    destinationCol: 'DESTINATION',
    rate: 'RATE',
    qty: 'QTY',
    nights: 'NIGHTS',
    total: 'TOTAL',
    subtotal: 'Subtotal',
    referenceNumber: 'Reference number',

    // Service notes (fixed disclaimer text)
    disclaimerNoReservation: 'This is currently NO reservation. Availability is limited. Prices and availability may change until confirmed.',
    disclaimerCityTax: 'City tax payable by guest directly at hotel upon arrival. The city tax is not included in the quoted price.',

    // Total bar
    totalLabel: 'TOTAL',

    // Terms payment callout
    paymentPrefix: 'Please pay',
    paymentUntil: 'until',

    // Meal plans
    mealBreakfast: 'Breakfast',
    mealHalfBoard: 'Half Board',
    mealFullBoard: 'Full Board',
    mealAllInclusive: 'All Inclusive',
    mealRoomOnly: 'Room Only',
};

const de: PdfTranslations = {
    // Header
    taxId: 'STEUER-NR.',

    // Section headings
    contract: 'Vertrag',
    preparedFor: 'Erstellt für',
    tripDetails: 'Reisedetails',
    hotelDetails: 'Hoteldetails',
    serviceDetails: 'Servicedetails',
    serviceNotes: 'Servicehinweise',
    cancellationConditions: 'Stornierungsbedingungen',
    termsAndConditions: 'Allgemeine Geschäftsbedingungen',
    issuedBy: 'AUSGESTELLT VON',

    // Company info labels
    assignedPerson: 'Zuständige Person',
    phoneNumber: 'Telefonnummer',
    website: 'Webseite',
    emailAddress: 'E-Mail-Adresse',
    address: 'Adresse',

    // Contract labels
    companyId: 'Firmen-ID',
    documentCode: 'Dokumentennummer',
    createdDate: 'Erstellungsdatum',

    // Prepared for labels
    customerPerson: 'Ansprechpartner',

    // Trip detail labels
    destination: 'Reiseziel',
    checkinOut: 'Ein-/Auschecken',
    guests: 'Gäste',

    // Hotel table headers
    destinationCol: 'REISEZIEL',
    rate: 'PREIS',
    qty: 'ANZ.',
    nights: 'NÄCHTE',
    total: 'GESAMT',
    subtotal: 'Zwischensumme',
    referenceNumber: 'Referenznummer',

    // Service notes (fixed disclaimer text)
    disclaimerNoReservation: 'Dies ist derzeit KEINE Reservierung. Die Verfügbarkeit ist begrenzt. Preise und Verfügbarkeit können sich bis zur Bestätigung ändern.',
    disclaimerCityTax: 'Die Kurtaxe ist vom Gast direkt bei Ankunft im Hotel zu entrichten. Die Kurtaxe ist nicht im angegebenen Preis enthalten.',

    // Total bar
    totalLabel: 'GESAMT',

    // Terms payment callout
    paymentPrefix: 'Bitte zahlen Sie',
    paymentUntil: 'bis zum',

    // Meal plans
    mealBreakfast: 'Frühstück',
    mealHalfBoard: 'Halbpension',
    mealFullBoard: 'Vollpension',
    mealAllInclusive: 'All Inclusive',
    mealRoomOnly: 'Nur Übernachtung',
};

const translations: Record<PdfLanguage, PdfTranslations> = { en, de };

/**
 * Returns the full PDF translation object for the given language.
 * Defaults to English if the language is not supported.
 */
export function getPdfTranslations(lang: PdfLanguage): PdfTranslations {
    return translations[lang] ?? translations.en;
}
