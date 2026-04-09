/**
 * PDF Generation Service — Figma-Matched Quotation PDF
 *
 * Generates professional offer PDFs matching the SETT Figma design.
 * Agent-visible only: hotel details, unified price, terms, disclaimer.
 * Does NOT contain: supplier names, split, buying price, markup.
 */

import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import { formatPhoneWithCountryCode } from '../utils/phoneParser';

// ─── Brand Colors (from Figma design) ────────────────────────────────────────

const BRAND_GREEN = '#6B8E23';
const BRAND_GREEN_DARK = '#4A6A10';
const DARK_TEXT = '#333333';
const MEDIUM_TEXT = '#555555';
const LIGHT_TEXT = '#888888';
const TABLE_HEADER_BG = '#F0F0F0';
const TABLE_ALT_ROW_BG = '#FAFAFA';
const BORDER_COLOR = '#DDDDDD';
const RED_WARNING = '#D32F2F';
const YELLOW_NOTE = '#F9A825';
const GREEN_NOTE = '#2E7D32';

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
    companyPhoneCountryCode?: string | null;
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
    contactPhoneCountryCode?: string | null;

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
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'N/A';
    try {
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
        return dateStr;
    }
}

function formatCurrency(amount: number, currency: string): string {
    return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function starString(rating: number | null): string {
    if (!rating) return '';
    return '\u2605'.repeat(Math.round(rating));
}

function stripHtml(html: string | null): string {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li>/gi, '  \u2022 ')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getLogoPath(): string | null {
    const candidates = [
        path.resolve(__dirname, '../publicfiles/Figma/SETT_logo.png'),
        path.resolve(__dirname, '../../src/publicfiles/Figma/SETT_logo.png'),
        path.resolve(process.cwd(), 'src/publicfiles/Figma/SETT_logo.png'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// ─── Page Layout Constants ───────────────────────────────────────────────────

const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const PAGE_WIDTH_INNER = 595.28 - MARGIN_LEFT - MARGIN_RIGHT; // A4 width
const MAX_Y = 760; // trigger new page before this Y position

// ─── Drawing Helpers ─────────────────────────────────────────────────────────

function checkPageBreak(doc: PDFKit.PDFDocument, requiredSpace: number): void {
    if (doc.y + requiredSpace > MAX_Y) {
        doc.addPage();
    }
}

function drawHorizontalLine(doc: PDFKit.PDFDocument, color = BORDER_COLOR): void {
    doc.moveTo(MARGIN_LEFT, doc.y)
        .lineTo(MARGIN_LEFT + PAGE_WIDTH_INNER, doc.y)
        .strokeColor(color)
        .lineWidth(0.5)
        .stroke();
    doc.moveDown(0.5);
}

function drawSectionHeader(doc: PDFKit.PDFDocument, title: string): void {
    checkPageBreak(doc, 30);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK_TEXT).text(title.toUpperCase());
    doc.moveDown(0.2);
    drawHorizontalLine(doc, BRAND_GREEN);
    doc.moveDown(0.3);
}

function drawLabelValue(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, labelWidth = 100, valueWidth = 150): void {
    doc.fontSize(8).font('Helvetica-Bold').fillColor(LIGHT_TEXT).text(label, x, y, { width: labelWidth });
    doc.fontSize(9).font('Helvetica').fillColor(DARK_TEXT).text(value || '-', x, y + 10, { width: valueWidth });
}

function drawCalloutBox(doc: PDFKit.PDFDocument, text: string, borderColor: string, label?: string): void {
    checkPageBreak(doc, 40);
    const boxY = doc.y;
    const boxWidth = PAGE_WIDTH_INNER;
    const textWidth = boxWidth - 20;

    // Measure text height
    const textHeight = doc.fontSize(8).font('Helvetica').heightOfString(text, { width: textWidth - 10 });
    const labelHeight = label ? 12 : 0;
    const boxHeight = Math.max(textHeight + labelHeight + 16, 30);

    // Box background
    doc.rect(MARGIN_LEFT, boxY, boxWidth, boxHeight).fillColor('#FAFAFA').fill();
    // Left border accent
    doc.rect(MARGIN_LEFT, boxY, 4, boxHeight).fillColor(borderColor).fill();

    // Label (if provided)
    if (label) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor(borderColor)
            .text(label, MARGIN_LEFT + 14, boxY + 6, { width: textWidth });
    }

    // Text
    doc.fontSize(8).font('Helvetica').fillColor(DARK_TEXT)
        .text(text, MARGIN_LEFT + 14, boxY + 6 + labelHeight, { width: textWidth - 10 });

    doc.y = boxY + boxHeight + 6;
}

// ─── Main PDF Generator ─────────────────────────────────────────────────────

export function generateOfferPdf(data: OfferPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: 40, bottom: 40, left: MARGIN_LEFT, right: MARGIN_RIGHT },
                bufferPages: true,
            });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 1: HEADER — Logo + "QUOTATION"
            // ═══════════════════════════════════════════════════════════════════

            const logoPath = getLogoPath();
            if (logoPath) {
                doc.image(logoPath, MARGIN_LEFT, 35, { width: 120 });
            } else {
                doc.fontSize(20).font('Helvetica-Bold').fillColor(BRAND_GREEN)
                    .text('SETT', MARGIN_LEFT, 40);
            }

            doc.fontSize(18).font('Helvetica-Bold').fillColor(BRAND_GREEN)
                .text('QUOTATION', MARGIN_LEFT, 40, { align: 'right' });

            // Green accent line
            doc.y = 75;
            doc.rect(MARGIN_LEFT, doc.y, PAGE_WIDTH_INNER, 3).fillColor(BRAND_GREEN).fill();
            doc.y = 85;

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 2: COMPANY INFO
            // ═══════════════════════════════════════════════════════════════════

            doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK_TEXT)
                .text(data.companyName || 'S & T T WORLDWIDE RESERVATION FZE', MARGIN_LEFT, doc.y);
            doc.moveDown(0.3);

            const companyInfoY = doc.y;
            const col1X = MARGIN_LEFT;
            const col2X = MARGIN_LEFT + 180;
            const col3X = MARGIN_LEFT + 340;

            drawLabelValue(doc, 'Assigned Person', data.assignedPerson || '-', col1X, companyInfoY);
            drawLabelValue(doc, 'Phone', formatPhoneWithCountryCode(data.companyPhoneCountryCode, data.companyPhone), col2X, companyInfoY);
            drawLabelValue(doc, 'Tax ID / Reg.', data.companyTaxId || '-', col3X, companyInfoY);

            doc.y = companyInfoY + 28;
            drawLabelValue(doc, 'Email', data.companyEmail || '-', col1X, doc.y);
            drawLabelValue(doc, 'Website', data.companyWebsite || '-', col2X, doc.y);

            doc.y += 28;
            if (data.companyAddress) {
                doc.fontSize(7).font('Helvetica').fillColor(LIGHT_TEXT)
                    .text(`Address: ${data.companyAddress}`, MARGIN_LEFT, doc.y, { width: PAGE_WIDTH_INNER });
            }

            doc.y += 14;
            drawHorizontalLine(doc);

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 3: PREPARED FOR
            // ═══════════════════════════════════════════════════════════════════

            drawSectionHeader(doc, 'Prepared For');

            const prepY = doc.y;
            drawLabelValue(doc, 'Contact Name', data.contactName, col1X, prepY);
            drawLabelValue(doc, 'Company', data.companyNameClient || '-', col2X, prepY);
            doc.y = prepY + 28;
            drawLabelValue(doc, 'Email', data.contactEmail || '-', col1X, doc.y);
            drawLabelValue(doc, 'Phone', formatPhoneWithCountryCode(data.contactPhoneCountryCode, data.contactPhone), col2X, doc.y);

            doc.y += 32;

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 4: TRIP DETAILS
            // ═══════════════════════════════════════════════════════════════════

            drawSectionHeader(doc, 'Trip Details');

            const tripY = doc.y;
            drawLabelValue(doc, 'Destination', data.destinationName, col1X, tripY);
            drawLabelValue(doc, 'Reference', `#${data.referenceNumber}`, col3X, tripY);
            doc.y = tripY + 28;
            drawLabelValue(doc, 'Check-in', formatDate(data.checkinDate), col1X, doc.y);
            drawLabelValue(doc, 'Check-out', formatDate(data.checkoutDate), col2X, doc.y);
            drawLabelValue(doc, 'Nights', String(data.nights), col3X, doc.y);

            doc.y += 32;

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 5: HOTEL DETAILS
            // ═══════════════════════════════════════════════════════════════════

            drawSectionHeader(doc, 'Hotel Details');

            for (let hi = 0; hi < data.hotels.length; hi++) {
                const hotel = data.hotels[hi];
                checkPageBreak(doc, 80);

                // Hotel header with star rating
                const hotelLabel = `${hi + 1}. ${hotel.hotelName}`;
                const stars = starString(hotel.starRating);
                doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK_TEXT)
                    .text(hotelLabel, MARGIN_LEFT, doc.y, { continued: !!stars });
                if (stars) {
                    doc.fillColor(YELLOW_NOTE).text(`  ${stars}`);
                }
                doc.fillColor(DARK_TEXT);

                // Address
                const addressParts = [hotel.addressCity, hotel.addressCountry].filter(Boolean);
                if (addressParts.length > 0) {
                    doc.fontSize(8).font('Helvetica').fillColor(LIGHT_TEXT)
                        .text(addressParts.join(', '));
                }
                doc.moveDown(0.3);

                // Room table header
                const tableY = doc.y;
                const roomCols = [170, 50, 70, 100, 100];
                const roomHeaders = ['Room Type', 'Qty', 'Meal', 'Price/Night', 'Total'];

                // Header background
                doc.rect(MARGIN_LEFT, tableY - 2, PAGE_WIDTH_INNER, 16).fillColor(TABLE_HEADER_BG).fill();

                let tx = MARGIN_LEFT + 5;
                doc.fontSize(7).font('Helvetica-Bold').fillColor(MEDIUM_TEXT);
                for (let c = 0; c < roomHeaders.length; c++) {
                    const align = c >= 3 ? 'right' : 'left';
                    doc.text(roomHeaders[c], tx, tableY + 2, { width: roomCols[c] - 10, align } as any);
                    tx += roomCols[c];
                }

                // Row
                const rowY = tableY + 18;
                tx = MARGIN_LEFT + 5;
                doc.fontSize(8).font('Helvetica').fillColor(DARK_TEXT);

                const roomTypeName = hotel.roomType.charAt(0).toUpperCase() + hotel.roomType.slice(1);
                const rowValues = [
                    roomTypeName,
                    String(hotel.roomQty),
                    hotel.mealPlan === 'BB' ? 'Breakfast' : hotel.mealPlan === 'RO' ? 'Room Only' : (hotel.mealPlan || '-'),
                    formatCurrency(hotel.pricePerRoomPerNight, data.currency),
                    formatCurrency(hotel.totalPrice, data.currency),
                ];

                for (let c = 0; c < rowValues.length; c++) {
                    const align = c >= 3 ? 'right' : 'left';
                    doc.text(rowValues[c], tx, rowY + 2, { width: roomCols[c] - 10, align } as any);
                    tx += roomCols[c];
                }

                // Subtotal line
                doc.y = rowY + 18;
                doc.moveTo(MARGIN_LEFT + 300, doc.y).lineTo(MARGIN_LEFT + PAGE_WIDTH_INNER, doc.y).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
                doc.y += 4;

                doc.fontSize(8).font('Helvetica-Bold').fillColor(DARK_TEXT)
                    .text(`Subtotal: ${formatCurrency(hotel.totalPrice, data.currency)}`, MARGIN_LEFT, doc.y, { align: 'right', width: PAGE_WIDTH_INNER });

                // Cancellation deadline
                if (hotel.cancelDeadline) {
                    doc.moveDown(0.2);
                    doc.fontSize(7).font('Helvetica').fillColor(GREEN_NOTE)
                        .text(`Free cancellation until ${formatDate(hotel.cancelDeadline)}`, MARGIN_LEFT, doc.y, { align: 'right', width: PAGE_WIDTH_INNER });
                }

                doc.fillColor(DARK_TEXT);
                doc.moveDown(1);

                // Separator between hotels
                if (hi < data.hotels.length - 1) {
                    drawHorizontalLine(doc, '#EEEEEE');
                    doc.moveDown(0.3);
                }
            }

            doc.moveDown(0.5);

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 6: SERVICE DETAILS (if any)
            // ═══════════════════════════════════════════════════════════════════

            if (data.services.length > 0) {
                drawSectionHeader(doc, 'Service Details');
                checkPageBreak(doc, 60);

                // Table header
                const svcTableY = doc.y;
                const svcCols = [190, 50, 50, 100, 100];
                const svcHeaders = ['Description', 'Qty', 'Days', 'Unit Price', 'Total'];

                doc.rect(MARGIN_LEFT, svcTableY - 2, PAGE_WIDTH_INNER, 16).fillColor(TABLE_HEADER_BG).fill();

                let sx = MARGIN_LEFT + 5;
                doc.fontSize(7).font('Helvetica-Bold').fillColor(MEDIUM_TEXT);
                for (let c = 0; c < svcHeaders.length; c++) {
                    const align = c >= 3 ? 'right' : 'left';
                    doc.text(svcHeaders[c], sx, svcTableY + 2, { width: svcCols[c] - 10, align } as any);
                    sx += svcCols[c];
                }

                let svcRowY = svcTableY + 18;
                for (let si = 0; si < data.services.length; si++) {
                    const svc = data.services[si];
                    checkPageBreak(doc, 20);

                    // Alternating row background
                    if (si % 2 === 1) {
                        doc.rect(MARGIN_LEFT, svcRowY - 2, PAGE_WIDTH_INNER, 16).fillColor(TABLE_ALT_ROW_BG).fill();
                    }

                    sx = MARGIN_LEFT + 5;
                    doc.fontSize(8).font('Helvetica').fillColor(DARK_TEXT);

                    const svcValues = [
                        svc.serviceName,
                        String(svc.quantity),
                        String(svc.days),
                        formatCurrency(svc.unitPrice, data.currency),
                        formatCurrency(svc.totalPrice, data.currency),
                    ];
                    for (let c = 0; c < svcValues.length; c++) {
                        const align = c >= 3 ? 'right' : 'left';
                        doc.text(svcValues[c], sx, svcRowY + 2, { width: svcCols[c] - 10, align } as any);
                        sx += svcCols[c];
                    }
                    svcRowY += 18;
                }
                doc.y = svcRowY + 5;
                doc.moveDown(0.5);
            }

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 7: SERVICE NOTES
            // ═══════════════════════════════════════════════════════════════════

            drawSectionHeader(doc, 'Service Notes');

            drawCalloutBox(doc,
                'This is currently NO reservation. Availability is limited. Prices and availability may change until confirmed.',
                RED_WARNING, 'Important');

            drawCalloutBox(doc,
                'City tax payable by guest directly at hotel upon arrival. The city tax is not included in the quoted price.',
                YELLOW_NOTE, 'City Tax');

            // Earliest cancellation deadline across all hotels
            const deadlines = data.hotels.map((h) => h.cancelDeadline).filter(Boolean) as string[];
            if (deadlines.length > 0) {
                const earliest = deadlines.sort()[0];
                drawCalloutBox(doc,
                    `Free cancellation available until ${formatDate(earliest)}. After this date, cancellation charges will apply as per the cancellation conditions below.`,
                    GREEN_NOTE, 'Cancellation');
            }

            if (data.specialRequirements) {
                drawCalloutBox(doc, data.specialRequirements, '#7B1FA2', 'Special Requirements');
            }

            if (data.customerNotes) {
                drawCalloutBox(doc, data.customerNotes, LIGHT_TEXT, 'Customer Notes');
            }

            doc.moveDown(0.5);

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 8: CANCELLATION CONDITIONS
            // ═══════════════════════════════════════════════════════════════════

            if (data.cancellationConditions) {
                drawSectionHeader(doc, 'Cancellation Conditions');
                const cxlText = stripHtml(data.cancellationConditions);
                doc.fontSize(8).font('Helvetica').fillColor(DARK_TEXT)
                    .text(cxlText, MARGIN_LEFT, doc.y, { width: PAGE_WIDTH_INNER });
                doc.moveDown(1);
            }

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 9: TERMS & CONDITIONS
            // ═══════════════════════════════════════════════════════════════════

            if (data.termsAndConditions) {
                drawSectionHeader(doc, 'Terms & Conditions');
                checkPageBreak(doc, 60);
                const termsText = stripHtml(data.termsAndConditions);
                doc.fontSize(7).font('Helvetica').fillColor(MEDIUM_TEXT)
                    .text(termsText, MARGIN_LEFT, doc.y, { width: PAGE_WIDTH_INNER });
                doc.moveDown(1);
            }

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 10: TOTAL PRICE BAR
            // ═══════════════════════════════════════════════════════════════════

            checkPageBreak(doc, 50);

            const totalBarY = doc.y + 5;
            doc.rect(MARGIN_LEFT, totalBarY, PAGE_WIDTH_INNER, 35).fillColor(BRAND_GREEN).fill();
            doc.fontSize(10).font('Helvetica').fillColor('#FFFFFF')
                .text('Total Price', MARGIN_LEFT + 15, totalBarY + 10);
            doc.fontSize(14).font('Helvetica-Bold').fillColor('#FFFFFF')
                .text(formatCurrency(data.totalPrice, data.currency), MARGIN_LEFT, totalBarY + 8, {
                    align: 'right',
                    width: PAGE_WIDTH_INNER - 15,
                });

            doc.y = totalBarY + 45;

            // Price breakdown note
            doc.fontSize(7).font('Helvetica').fillColor(LIGHT_TEXT)
                .text(
                    `${formatCurrency(data.sellingPricePerRoomPerNight, data.currency)} per room per night \u00D7 ${data.totalRooms} rooms \u00D7 ${data.nights} nights`,
                    { align: 'right', width: PAGE_WIDTH_INNER },
                );

            // ═══════════════════════════════════════════════════════════════════
            // SECTION 11: FOOTER (on every page)
            // ═══════════════════════════════════════════════════════════════════

            const totalPages = doc.bufferedPageRange().count;
            for (let i = 0; i < totalPages; i++) {
                doc.switchToPage(i);

                // Green footer bar
                doc.rect(MARGIN_LEFT, 800, PAGE_WIDTH_INNER, 2).fillColor(BRAND_GREEN).fill();

                // Footer text
                doc.fontSize(7).font('Helvetica').fillColor(LIGHT_TEXT);
                doc.text(
                    data.companyName || 'SETT — Sport & Events Tours & Travel',
                    MARGIN_LEFT, 806,
                    { width: PAGE_WIDTH_INNER / 2 },
                );
                doc.text(
                    `Page ${i + 1} of ${totalPages}`,
                    MARGIN_LEFT, 806,
                    { width: PAGE_WIDTH_INNER, align: 'right' },
                );
            }

            doc.end();
        } catch (err) {
            logger.error({ err }, 'PDF generation failed');
            reject(err);
        }
    });
}
