/**
 * PDF Generation Service — Figma-Matched Quotation PDF
 *
 * Generates professional offer PDFs matching the SETT Figma design exactly.
 * Uses Montserrat font, navy/grey color scheme, rounded bordered cards.
 * Agent-visible only: hotel details, unified price, terms, disclaimer.
 * Does NOT contain: supplier names, split, buying price, markup.
 */

import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import { PdfLanguage, PdfTranslations, getPdfTranslations } from '../i18n/pdfTranslations';

// ─── Brand Colors (from Figma specs) ─────────────────────────────────────────

const NAVY = '#071C42';
const GREY_68 = '#686868';
const GREY_4A = '#4A4A4A';
const DARK_1D = '#1D1D1D';
const SEPARATOR = '#68686866'; // 40% opacity grey — rendered as solid light grey
const SEPARATOR_SOLID = '#C8C8C8'; // Approximate visual for 40% #686868
const WHITE = '#FFFFFF';
const TOTAL_BG = '#E8EBF0'; // Approximation for #071C421A (navy 10%)
const PINK_BG = '#FFEAEB';

// ─── Types ───────────────────────────────────────────────────────────────────

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
    // Company (from settings)
    companyName: string;
    companyAddress: string;
    companyPhone: string;
    companyEmail: string;
    companyWebsite: string;
    companyTaxId: string;
    assignedPerson: string;

    // Client
    referenceNumber: number;
    contactName: string;
    companyNameClient: string;
    contactEmail: string;
    contactPhone: string;

    // Trip
    destinationName: string;
    checkinDate: string;
    checkoutDate: string;
    nights: number;

    // Hotels
    hotels: OfferHotel[];

    // Services
    services: OfferService[];

    // Notes & Policies
    specialRequirements: string | null;
    customerNotes: string | null;
    cancellationConditions: string | null;
    termsAndConditions: string | null;

    // Totals
    currency: string;
    totalPrice: number;
    sellingPricePerRoomPerNight: number;
    totalRooms: number;

    // Language (defaults to 'en')
    language?: PdfLanguage;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'N/A';
    try {
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
        return dateStr;
    }
}

function formatDateLong(dateStr: string | null): string {
    if (!dateStr) return 'N/A';
    try {
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
        return dateStr;
    }
}

function formatCheckinOut(checkin: string | null, checkout: string | null): string {
    if (!checkin || !checkout) return 'N/A';
    try {
        const ci = new Date(checkin);
        const co = new Date(checkout);
        const monthIn = ci.toLocaleDateString('en-US', { month: 'long' });
        const dayIn = ci.getDate();
        const monthOut = co.toLocaleDateString('en-US', { month: 'long' });
        const dayOut = co.getDate();
        const year = co.getFullYear();
        if (monthIn === monthOut) {
            return `${monthIn} ${dayIn} - ${monthOut} ${dayOut}, ${year}`;
        }
        return `${monthIn} ${dayIn} - ${monthOut} ${dayOut}, ${year}`;
    } catch {
        return `${checkin} - ${checkout}`;
    }
}

function formatCurrency(amount: number, currency: string): string {
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCurrencyWithCode(amount: number, currency: string): string {
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function stripHtml(html: string | null): string[] {
    if (!html) return [];
    const text = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li>/gi, '\u2022 ')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

function mealLabel(code: string, t: PdfTranslations): string {
    switch (code?.toUpperCase()) {
        case 'BB': return t.mealBreakfast;
        case 'HB': return t.mealHalfBoard;
        case 'FB': return t.mealFullBoard;
        case 'AI': return t.mealAllInclusive;
        case 'RO': return t.mealRoomOnly;
        default: return code || '-';
    }
}

// ─── Font Helpers ────────────────────────────────────────────────────────────

function getFontPath(weight: string): string | null {
    const candidates = [
        path.resolve(__dirname, `../publicfiles/fonts/Montserrat-${weight}.ttf`),
        path.resolve(__dirname, `../../src/publicfiles/fonts/Montserrat-${weight}.ttf`),
        path.resolve(process.cwd(), `src/publicfiles/fonts/Montserrat-${weight}.ttf`),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function getAssetPath(filename: string): string | null {
    const candidates = [
        path.resolve(__dirname, `../publicfiles/Figma/${filename}`),
        path.resolve(__dirname, `../../src/publicfiles/Figma/${filename}`),
        path.resolve(process.cwd(), `src/publicfiles/Figma/${filename}`),
        path.resolve(__dirname, `../publicfiles/${filename}`),
        path.resolve(__dirname, `../../src/publicfiles/${filename}`),
        path.resolve(process.cwd(), `src/publicfiles/${filename}`),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// ─── Font Names (registered at doc creation) ────────────────────────────────

const FONT_REGULAR = 'Mont-Regular';
const FONT_MEDIUM = 'Mont-Medium';
const FONT_SEMIBOLD = 'Mont-SemiBold';
const FONT_BOLD = 'Mont-Bold';

// Fallbacks if Montserrat files not found
const FALLBACK_REGULAR = 'Helvetica';
const FALLBACK_MEDIUM = 'Helvetica';
const FALLBACK_SEMIBOLD = 'Helvetica-Bold';
const FALLBACK_BOLD = 'Helvetica-Bold';

// ─── Layout Constants ────────────────────────────────────────────────────────

const ML = 20; // margin left (per Figma: left: 20px)
const MR = 20;
const PAGE_W = 595.28; // A4
const CW = PAGE_W - ML - MR; // ~555 (Figma uses 710 at 96dpi ≈ 555pt at 72dpi)
const MAX_Y = 780;
const FOOTER_Y = 810;

// Column positions (3 column layout: left, center, right)
const COL1 = ML;
const COL2 = ML + 185;
const COL3 = ML + 370;

// ─── Drawing Helpers ─────────────────────────────────────────────────────────

let fontReg: string;
let fontMed: string;
let fontSemi: string;
let fontBold: string;

function registerFonts(doc: PDFKit.PDFDocument): void {
    const reg = getFontPath('Regular');
    const med = getFontPath('Medium');
    const semi = getFontPath('SemiBold');
    const bold = getFontPath('Bold');

    if (reg) {
        doc.registerFont(FONT_REGULAR, reg);
        fontReg = FONT_REGULAR;
    } else {
        fontReg = FALLBACK_REGULAR;
    }
    if (med) {
        doc.registerFont(FONT_MEDIUM, med);
        fontMed = FONT_MEDIUM;
    } else {
        fontMed = FALLBACK_MEDIUM;
    }
    if (semi) {
        doc.registerFont(FONT_SEMIBOLD, semi);
        fontSemi = FONT_SEMIBOLD;
    } else {
        fontSemi = FALLBACK_SEMIBOLD;
    }
    if (bold) {
        doc.registerFont(FONT_BOLD, bold);
        fontBold = FONT_BOLD;
    } else {
        fontBold = FALLBACK_BOLD;
    }
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
    if (doc.y + needed > MAX_Y) {
        doc.addPage();
        doc.y = 30;
    }
}

function separatorLine(doc: PDFKit.PDFDocument, y?: number): void {
    const lineY = y ?? doc.y;
    doc.moveTo(ML, lineY)
        .lineTo(ML + CW, lineY)
        .strokeColor(SEPARATOR_SOLID)
        .lineWidth(0.5)
        .stroke();
    if (!y) doc.y = lineY + 12;
}

function sectionHeading(doc: PDFKit.PDFDocument, title: string): void {
    ensureSpace(doc, 45);
    doc.fontSize(12).font(fontSemi).fillColor(NAVY)
        .text(title.toUpperCase(), ML, doc.y, { lineBreak: false });
    doc.y += 18; // space below heading before content
}

function fieldLabel(doc: PDFKit.PDFDocument, label: string, x: number, y: number): void {
    doc.fontSize(9).font(fontReg).fillColor(NAVY)
        .text(label.toUpperCase(), x, y, { lineBreak: false });
}

function fieldValue(doc: PDFKit.PDFDocument, value: string, x: number, y: number, opts: { width?: number; color?: string; font?: string; size?: number } = {}): void {
    doc.fontSize(opts.size ?? 10.5)
        .font(opts.font ?? fontMed)
        .fillColor(opts.color ?? GREY_68)
        .text(value || '-', x, y, { width: opts.width ?? 170, lineBreak: false });
}

function labelValue(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, valueWidth = 170): number {
    fieldLabel(doc, label, x, y);
    fieldValue(doc, value, x, y + 13);
    return 30; // height consumed
}

// ─── Rounded Bordered Card ──────────────────────────────────────────────────

function drawCardStart(doc: PDFKit.PDFDocument, height: number): number {
    const startY = doc.y;
    doc.roundedRect(ML, startY, CW, height, 10)
        .strokeColor(SEPARATOR_SOLID)
        .lineWidth(0.5)
        .stroke();
    return startY;
}

// ─── Main PDF Generator ─────────────────────────────────────────────────────

export function generateOfferPdf(data: OfferPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: 20, bottom: 20, left: ML, right: MR },
                bufferPages: true,
            });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            registerFonts(doc);

            const lang = data.language ?? 'en';
            const t = getPdfTranslations(lang);
            const today = formatDate(new Date().toISOString());

            // ═══════════════════════════════════════════════════════════════
            // HEADER — Logo (left) + Tax ID (right)
            // ═══════════════════════════════════════════════════════════════

            const logoPath = getAssetPath('SETT_logo.png');
            if (logoPath) {
                doc.image(logoPath, ML, 20, { width: 83 }); // ~111px at 96dpi ≈ 83pt
            } else {
                doc.fontSize(18).font(fontBold).fillColor('#AAC737')
                    .text('SETT', ML, 22, { lineBreak: false });
            }

            // Tax ID on the right
            const taxX = ML + CW - 170;
            doc.fontSize(9).font(fontReg).fillColor(NAVY)
                .text(t.taxId, taxX, 22, { width: 170, align: 'right', lineBreak: false });
            doc.fontSize(10.5).font(fontMed).fillColor(NAVY)
                .text(data.companyTaxId || '-', taxX, 36, { width: 170, align: 'right', lineBreak: false });

            // Separator line below header
            doc.y = 60;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // COMPANY INFO SECTION
            // ═══════════════════════════════════════════════════════════════

            doc.y += 6;

            // Company name heading
            doc.fontSize(12).font(fontSemi).fillColor(NAVY)
                .text((data.companyName || 'S-E-T-T Worldwide Reservation FZE').toUpperCase(), ML, doc.y, { lineBreak: false });
            doc.y += 22;

            // Row 1: Assigned Person | Phone Number | Website
            const row1Y = doc.y;
            labelValue(doc, t.assignedPerson, data.assignedPerson || '-', COL1, row1Y);
            labelValue(doc, t.phoneNumber, data.companyPhone || '-', COL2, row1Y);
            labelValue(doc, t.website, data.companyWebsite || '-', COL3, row1Y);

            // Row 2: Email Address | Address
            const row2Y = row1Y + 38;
            labelValue(doc, t.emailAddress, data.companyEmail || '-', COL1, row2Y);
            labelValue(doc, t.address, data.companyAddress || '-', COL2, row2Y, CW - 185);

            doc.y = row2Y + 42;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // CONTRACT SECTION
            // ═══════════════════════════════════════════════════════════════

            sectionHeading(doc, t.contract);

            const contY = doc.y;
            labelValue(doc, t.companyId, `#${data.referenceNumber}`, COL1, contY);
            labelValue(doc, t.documentCode, `OFF-${String(data.referenceNumber).padStart(6, '0')}`, COL2, contY);
            labelValue(doc, t.createdDate, today, COL3, contY);

            doc.y = contY + 40;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // PREPARED FOR
            // ═══════════════════════════════════════════════════════════════

            sectionHeading(doc, t.preparedFor);

            const prepY = doc.y;
            labelValue(doc, t.customerPerson, data.contactName || '-', COL1, prepY);
            labelValue(doc, t.emailAddress, data.contactEmail || '-', COL2, prepY);
            labelValue(doc, t.phoneNumber, data.contactPhone || '-', COL3, prepY);

            const prepY2 = prepY + 38;
            labelValue(doc, t.address, data.companyNameClient || '-', COL1, prepY2, CW);

            doc.y = prepY2 + 40;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // TRIP DETAILS
            // ═══════════════════════════════════════════════════════════════

            sectionHeading(doc, t.tripDetails);

            const tripY = doc.y;
            labelValue(doc, t.destination, data.destinationName || '-', COL1, tripY);
            labelValue(doc, t.checkinOut, formatCheckinOut(data.checkinDate, data.checkoutDate), COL2, tripY, 200);
            labelValue(doc, t.guests, String(data.totalRooms * 2), COL3, tripY);

            doc.y = tripY + 40;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // HOTEL DETAILS
            // ═══════════════════════════════════════════════════════════════

            sectionHeading(doc, t.hotelDetails);

            for (let hi = 0; hi < data.hotels.length; hi++) {
                const hotel = data.hotels[hi];
                ensureSpace(doc, 150);

                // Hotel header row: icon + name (left), Reference number (right)
                const hotelHeaderY = doc.y;
                doc.fontSize(10.5).font(fontSemi).fillColor(NAVY)
                    .text(`\u2302  ${hotel.hotelName}`, ML, hotelHeaderY, { width: CW * 0.6, lineBreak: false });

                const addressParts = [hotel.addressCity, hotel.addressCountry].filter(Boolean);
                if (addressParts.length) {
                    doc.font(fontReg).fillColor(GREY_68).fontSize(9)
                        .text(`   ${addressParts.join(', ')}`, ML, hotelHeaderY + 14, { width: CW * 0.6, lineBreak: false });
                }

                doc.fontSize(10.5).font(fontSemi).fillColor(GREY_4A)
                    .text(`${t.referenceNumber}: #${data.referenceNumber}`, ML, hotelHeaderY, {
                        width: CW,
                        align: 'right',
                        lineBreak: false,
                    });

                doc.y = hotelHeaderY + 24;

                // Calculate card height based on room rows
                const roomName = hotel.roomType.charAt(0).toUpperCase() + hotel.roomType.slice(1);
                const cardHeight = 110; // header + 1 room row + separator + subtotal

                // Draw bordered card
                const cardY = doc.y;
                doc.roundedRect(ML, cardY, CW, cardHeight, 10)
                    .strokeColor(SEPARATOR_SOLID)
                    .lineWidth(0.5)
                    .stroke();

                // Table headers inside card
                const hdrY = cardY + 12;
                const tCol1 = ML + 13;
                const tCol2 = ML + 335; // RATE
                const tCol3 = ML + 395; // QTY
                const tCol4 = ML + 440; // NIGHTS
                const tCol5 = ML + CW - 13; // TOTAL (right aligned)

                doc.fontSize(9).font(fontSemi).fillColor(GREY_68);
                doc.text(t.destinationCol, tCol1, hdrY, { lineBreak: false });
                doc.text(t.rate, tCol2, hdrY, { lineBreak: false });
                doc.text(t.qty, tCol3, hdrY, { lineBreak: false });
                doc.text(t.nights, tCol4, hdrY, { lineBreak: false });
                doc.text(`${t.total}(${data.currency})`, tCol5 - 70, hdrY, { width: 70, align: 'right', lineBreak: false });

                // Header separator inside card
                const hdrLineY = hdrY + 16;
                doc.moveTo(ML + 13, hdrLineY)
                    .lineTo(ML + CW - 13, hdrLineY)
                    .strokeColor(SEPARATOR_SOLID)
                    .lineWidth(0.5)
                    .stroke();

                // Room data row
                const rowY = hdrLineY + 10;
                doc.fontSize(10.5).font(fontReg).fillColor(DARK_1D)
                    .text(roomName, tCol1, rowY, { width: 310, lineBreak: false });

                doc.fontSize(10.5).font(fontReg).fillColor(GREY_4A);
                doc.text(formatCurrency(hotel.pricePerRoomPerNight, data.currency), tCol2 - 10, rowY, { width: 60, lineBreak: false });
                doc.text(String(hotel.roomQty), tCol3, rowY, { width: 40, lineBreak: false });
                doc.text(String(data.nights), tCol4, rowY, { width: 45, lineBreak: false });

                // Total value in navy bold
                doc.fontSize(10.5).font(fontSemi).fillColor(NAVY)
                    .text(formatCurrency(hotel.totalPrice, data.currency), tCol5 - 70, rowY, { width: 70, align: 'right', lineBreak: false });

                // Separator before subtotal
                const subLineY = rowY + 22;
                doc.moveTo(ML + 13, subLineY)
                    .lineTo(ML + CW - 13, subLineY)
                    .strokeColor(SEPARATOR_SOLID)
                    .lineWidth(0.5)
                    .stroke();

                // Subtotal row (right aligned)
                const subY = subLineY + 10;
                doc.fontSize(9).font(fontSemi).fillColor(GREY_68)
                    .text(t.subtotal, tCol5 - 150, subY, { width: 80, lineBreak: false });
                doc.fontSize(10.5).font(fontSemi).fillColor(NAVY)
                    .text(formatCurrency(hotel.totalPrice, data.currency), tCol5 - 70, subY, { width: 70, align: 'right', lineBreak: false });

                doc.y = cardY + cardHeight + 14;

                if (hi < data.hotels.length - 1) {
                    doc.y += 8;
                }
            }

            doc.y += 4;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // SERVICE DETAILS
            // ═══════════════════════════════════════════════════════════════

            if (data.services.length > 0) {
                sectionHeading(doc, t.serviceDetails);
                ensureSpace(doc, 100);

                // Calculate card height
                const svcCardHeight = 48 + data.services.length * 26 + 35;
                const svcCardY = doc.y;

                doc.roundedRect(ML, svcCardY, CW, svcCardHeight, 10)
                    .strokeColor(SEPARATOR_SOLID)
                    .lineWidth(0.5)
                    .stroke();

                // Service table headers
                const shY = svcCardY + 12;
                const sCol1 = ML + 13;
                const sCol2 = ML + 335;
                const sCol3 = ML + 395;
                const sCol4 = ML + 440;
                const sCol5 = ML + CW - 13;

                doc.fontSize(9).font(fontSemi).fillColor(NAVY);
                doc.text(t.destinationCol, sCol1, shY, { lineBreak: false });
                doc.text(t.rate, sCol2, shY, { lineBreak: false });
                doc.text(t.qty, sCol3, shY, { lineBreak: false });
                doc.text(t.nights, sCol4, shY, { lineBreak: false });
                doc.text(`${t.total}(${data.currency})`, sCol5 - 70, shY, { width: 70, align: 'right', lineBreak: false });

                // Header separator
                const shLineY = shY + 16;
                doc.moveTo(ML + 13, shLineY)
                    .lineTo(ML + CW - 13, shLineY)
                    .strokeColor(SEPARATOR_SOLID)
                    .lineWidth(0.5)
                    .stroke();

                // Service rows
                let sRowY = shLineY + 10;
                let svcSubtotal = 0;

                for (const svc of data.services) {
                    doc.fontSize(10.5).font(fontReg).fillColor(NAVY)
                        .text(svc.serviceName, sCol1, sRowY, { width: 310, lineBreak: false });

                    doc.fontSize(10.5).font(fontReg).fillColor(GREY_68);
                    doc.text(formatCurrency(svc.unitPrice, data.currency), sCol2 - 10, sRowY, { width: 60, lineBreak: false });
                    doc.text(String(svc.quantity), sCol3, sRowY, { width: 40, lineBreak: false });
                    doc.text(String(svc.days), sCol4, sRowY, { width: 45, lineBreak: false });

                    doc.fontSize(10.5).font(fontSemi).fillColor(NAVY)
                        .text(formatCurrency(svc.totalPrice, data.currency), sCol5 - 70, sRowY, { width: 70, align: 'right', lineBreak: false });

                    svcSubtotal += svc.totalPrice;
                    sRowY += 26;
                }

                // Separator before subtotal
                doc.moveTo(ML + 13, sRowY - 4)
                    .lineTo(ML + CW - 13, sRowY - 4)
                    .strokeColor(SEPARATOR_SOLID)
                    .lineWidth(0.5)
                    .stroke();

                // Subtotal
                const sSubY = sRowY + 6;
                doc.fontSize(9).font(fontSemi).fillColor(GREY_68)
                    .text(t.subtotal, sCol5 - 150, sSubY, { width: 80, lineBreak: false });
                doc.fontSize(10.5).font(fontSemi).fillColor(NAVY)
                    .text(formatCurrency(svcSubtotal, data.currency), sCol5 - 70, sSubY, { width: 70, align: 'right', lineBreak: false });

                doc.y = svcCardY + svcCardHeight + 12;
                separatorLine(doc);
            }

            // ═══════════════════════════════════════════════════════════════
            // SERVICE NOTES
            // ═══════════════════════════════════════════════════════════════

            sectionHeading(doc, t.serviceNotes);

            const noteLines: string[] = [];
            if (data.specialRequirements) {
                noteLines.push(data.specialRequirements);
            }
            if (data.customerNotes) {
                noteLines.push(data.customerNotes);
            }
            // Default service notes (translated)
            noteLines.push(t.disclaimerNoReservation);
            noteLines.push(t.disclaimerCityTax);

            for (const note of noteLines) {
                ensureSpace(doc, 22);
                doc.fontSize(10.5).font(fontReg).fillColor(DARK_1D)
                    .text(`\u2022  ${note}`, ML, doc.y, { width: CW, lineGap: 3 });
                doc.y += 8;
            }

            doc.y += 6;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // TOTAL BAR (rounded, light navy background)
            // ═══════════════════════════════════════════════════════════════

            ensureSpace(doc, 50);

            const totalBarY = doc.y;
            doc.roundedRect(ML, totalBarY, CW, 35, 10)
                .fillColor(TOTAL_BG).fill();

            // TOTAL label + value (right aligned within the bar)
            doc.fontSize(9).font(fontSemi).fillColor(GREY_68)
                .text(t.totalLabel, ML + CW - 160, totalBarY + 11, { width: 50, lineBreak: false });
            doc.fontSize(10.5).font(fontSemi).fillColor(NAVY)
                .text(formatCurrencyWithCode(data.totalPrice, data.currency), ML + CW - 100, totalBarY + 10, { width: 86, align: 'right', lineBreak: false });

            doc.y = totalBarY + 45;
            separatorLine(doc);

            // ═══════════════════════════════════════════════════════════════
            // CANCELLATION CONDITIONS
            // ═══════════════════════════════════════════════════════════════

            if (data.cancellationConditions) {
                sectionHeading(doc, t.cancellationConditions);

                const cxlLines = stripHtml(data.cancellationConditions);
                for (const line of cxlLines) {
                    ensureSpace(doc, 18);
                    const bullet = line.startsWith('\u2022') ? line : `\u2022  ${line}`;
                    doc.fontSize(10.5).font(fontReg).fillColor(DARK_1D)
                        .text(bullet, ML, doc.y, { width: CW, lineGap: 3 });
                    doc.y += 4;
                }

                doc.y += 4;
                separatorLine(doc);
            }

            // ═══════════════════════════════════════════════════════════════
            // TERMS & CONDITIONS
            // ═══════════════════════════════════════════════════════════════

            if (data.termsAndConditions) {
                sectionHeading(doc, t.termsAndConditions);

                const termsLines = stripHtml(data.termsAndConditions);

                for (let ti = 0; ti < termsLines.length; ti++) {
                    ensureSpace(doc, 18);
                    const line = termsLines[ti];
                    const bullet = line.startsWith('\u2022') ? line : `\u2022  ${line}`;
                    doc.fontSize(10.5).font(fontReg).fillColor(NAVY)
                        .text(bullet, ML, doc.y, { width: CW, lineGap: 3 });
                    doc.y += 4;

                    // After 5th bullet, insert payment callout box (pink)
                    if (ti === 4) {
                        ensureSpace(doc, 40);
                        const payY = doc.y + 4;

                        // Find earliest cancellation deadline for payment date
                        const deadlines = data.hotels.map((h) => h.cancelDeadline).filter(Boolean) as string[];
                        const payDate = deadlines.length > 0 ? formatDate(deadlines.sort()[0]) : today;
                        const payText = `${t.paymentPrefix} ${formatCurrencyWithCode(data.totalPrice, data.currency)} ${t.paymentUntil} ${payDate}.`;

                        doc.roundedRect(ML, payY, CW, 35, 10)
                            .fillColor(PINK_BG).fill();

                        doc.fontSize(10.5).font(fontSemi).fillColor(NAVY)
                            .text(payText, ML + 14, payY + 11, { width: CW - 28, lineBreak: false });

                        doc.y = payY + 42;
                    }
                }

                doc.y += 4;
                separatorLine(doc);
            }

            // ═══════════════════════════════════════════════════════════════
            // ISSUED BY
            // ═══════════════════════════════════════════════════════════════

            ensureSpace(doc, 50);

            doc.fontSize(12).font(fontSemi).fillColor(NAVY)
                .text(t.issuedBy, ML, doc.y, { width: CW, align: 'right' });
            doc.y += 16;
            doc.fontSize(10.5).font(fontReg).fillColor(DARK_1D)
                .text(data.assignedPerson || data.companyName || '-', ML, doc.y, {
                    width: CW,
                    align: 'right',
                });

            // ═══════════════════════════════════════════════════════════════
            // FOOTER — line only on every page (no doc.text to avoid ghost pages)
            // ═══════════════════════════════════════════════════════════════

            const range = doc.bufferedPageRange();
            for (let i = 0; i < range.count; i++) {
                doc.switchToPage(i);
                doc.save();
                doc.moveTo(ML, FOOTER_Y)
                    .lineTo(ML + CW, FOOTER_Y)
                    .strokeColor(SEPARATOR_SOLID)
                    .lineWidth(0.5)
                    .stroke();
                doc.restore();
            }

            doc.end();
        } catch (err) {
            logger.error({ err }, 'PDF generation failed');
            reject(err);
        }
    });
}
