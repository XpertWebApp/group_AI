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

    // Hotel + service table headers
    /**
     * First column header. On the Hotel table it labels the room type
     * (Double, Twin, Standard Double Beds, …). On the Service table it
     * labels the service name (Airport transfer, Excursion, …). Both
     * tables reuse the same key for visual consistency — the value
     * itself reads naturally as "Room Type" / "Zimmertyp".
     */
    roomTypeCol: string;
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

    // Brand header / footer
    /** H1 on the hero band of page 1 — "GROUP OFFER" / "GRUPPENANGEBOT". */
    offerTitle: string;
    /** Footer page-of indicator. Use `{n}` and `{total}` placeholders. */
    pageOf: string;
    /** Footer confidentiality label. */
    confidential: string;

    // Meal plans
    mealBreakfast: string;
    mealHalfBoard: string;
    mealFullBoard: string;
    mealAllInclusive: string;
    mealRoomOnly: string;

    // ── Redesigned PDF (2026-06-02 — FE handover) ──────────────────────────
    // Strings added to support the brand-spec PDF redesign that matches the
    // FE preview modal. Keys named after the slice the FE doc uses
    // (`offer.contract.*`) so cross-referencing remains easy.

    /** Green small-caps ribbon in the navy header. */
    offer: string;
    /** "Document No." prefix in the header (the value gets appended). */
    documentNo: string;
    /** Small-caps green label above the supplier column. */
    supplier: string;
    /** Small-caps green label above the customer column. */
    customer: string;
    /** Reservation reference label shown next to each hotel name. */
    reservationRef: string;
    /** Service-details table — first column header. */
    service: string;
    /** Service-details table — date column header. */
    date: string;
    /** Hotel-details table — sell column header. (Replaces the old `rate`.) */
    sell: string;
    /** Bottom-of-document grand-total bar label. */
    grandTotal: string;
    /** Payment-details section heading. */
    paymentDetails: string;
    /** Payment-due pill — "Please pay {amount} by {date}." */
    payPrompt: string;
    /** Payment-due pill — connector between amount and due-date. */
    payBy: string;
    /** Bank-table row labels. */
    bankName: string;
    accountHolder: string;
    iban: string;
    swiftBic: string;
    /** Long legal blurb shown in the footer (left side). */
    footerLegal: string;
    /** Single MetaRow label rendered next to the customer's name. */
    contactPerson: string;
    /** Single MetaRow label rendered when the BookingRequest has no `hotelLocation` set. */
    addressFallback: string;
}

const en: PdfTranslations = {
    // Header
    /**
     * Identifier of the LTD (Canadian) issuing entity — Oliver explicitly
     * asked for "Ontario Corporation Number" wording instead of the
     * generic "Tax ID". The value itself (e.g. 1001233897) flows from
     * settings → companyDetails.taxId → OfferPdfData.companyTaxId.
     */
    taxId: 'Ontario Corporation Number',

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
    roomTypeCol: 'ROOM TYPE',
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

    // Brand header / footer
    offerTitle: 'GROUP OFFER',
    pageOf: 'Page {n} of {total}',
    confidential: 'Confidential',

    // Meal plans
    mealBreakfast: 'Breakfast',
    mealHalfBoard: 'Half Board',
    mealFullBoard: 'Full Board',
    mealAllInclusive: 'All Inclusive',
    mealRoomOnly: 'Room Only',

    // Redesigned PDF (FE handover)
    offer: 'OFFER',
    documentNo: 'Document No.',
    supplier: 'Supplier',
    customer: 'Customer',
    reservationRef: 'Reservation Ref.',
    service: 'Service',
    date: 'Date',
    sell: 'Sell',
    grandTotal: 'Grand Total',
    paymentDetails: 'Payment Details',
    payPrompt: 'Please pay',
    payBy: 'by',
    bankName: 'Bank Name',
    accountHolder: 'Account Holder',
    iban: 'IBAN',
    swiftBic: 'SWIFT / BIC',
    footerLegal: '© 2026 S-E-T-T Worldwide Reservation FZE. All rights reserved. This document is generated electronically and is valid without signature.',
    contactPerson: 'Contact Person',
    addressFallback: 'Address',
};

const de: PdfTranslations = {
    // Header — same Ontario Corp Number label in both languages: the
    // identifier is jurisdiction-specific and not translated.
    taxId: 'Ontario Corporation Number',

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
    roomTypeCol: 'ZIMMERTYP',
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

    // Brand header / footer
    offerTitle: 'GRUPPENANGEBOT',
    pageOf: 'Seite {n} von {total}',
    confidential: 'Vertraulich',

    // Meal plans
    mealBreakfast: 'Frühstück',
    mealHalfBoard: 'Halbpension',
    mealFullBoard: 'Vollpension',
    mealAllInclusive: 'All Inclusive',
    mealRoomOnly: 'Nur Übernachtung',

    // Redesigned PDF (FE handover)
    offer: 'ANGEBOT',
    documentNo: 'Dokument Nr.',
    supplier: 'Lieferant',
    customer: 'Kunde',
    reservationRef: 'Reservierungs-Ref.',
    service: 'Service',
    date: 'Datum',
    sell: 'Preis',
    grandTotal: 'Gesamtsumme',
    paymentDetails: 'Zahlungsdetails',
    payPrompt: 'Bitte zahlen Sie',
    payBy: 'bis',
    bankName: 'Bankname',
    accountHolder: 'Kontoinhaber',
    iban: 'IBAN',
    swiftBic: 'SWIFT / BIC',
    footerLegal: '© 2026 S-E-T-T Worldwide Reservation FZE. Alle Rechte vorbehalten. Dieses Dokument wird elektronisch erstellt und ist auch ohne Unterschrift gültig.',
    contactPerson: 'Ansprechpartner',
    addressFallback: 'Adresse',
};

const translations: Record<PdfLanguage, PdfTranslations> = { en, de };

/**
 * Returns the full PDF translation object for the given language.
 * Defaults to English if the language is not supported.
 */
export function getPdfTranslations(lang: PdfLanguage): PdfTranslations {
    return translations[lang] ?? translations.en;
}
