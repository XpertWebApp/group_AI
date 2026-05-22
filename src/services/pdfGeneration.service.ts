/**
 * PDF Generation Service — Demo Placeholder
 *
 * NOTE: The full quotation PDF design is part of Milestone 5 and is not
 * implemented in this milestone. This file generates a brand-compliant
 * placeholder PDF so the document still feels like SETT even before the
 * final layout lands. Visual decisions follow SETT Hub Brand Guidelines v2:
 * Montserrat typography (§3), SETT palette (§2), Group Offer logo for
 * AI-generated offers (§4.5), green bottom bar (§7.1 / §8.2).
 *
 * The exported types (`OfferPdfData`, `OfferHotel`, `OfferService`) and the
 * `generateOfferPdf` function signature are kept intact so the rest of the
 * application (proposals service, controller, email attachments) continues
 * to work without changes.
 */

import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import { formatDateEU } from '../utils/dateFormatter';

// ─── Types (kept intact for compatibility with proposals.service.ts) ─────────

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

// ─── SETT Brand Palette (Brand Guidelines v2 §2) ─────────────────────────────

const NAVY = '#071C42';        // primary dark / headers / hero
const GREEN = '#AAC737';       // primary accent / CTAs / bottom bar
const GREEN_DARK = '#7A9420';  // depth accent
const GREY = '#686868';        // body text / labels
const BORDER = '#E0E0E0';      // 1 px borders
const BG_LIGHT = '#F8F9FA';    // card surface (§5.2)
const WHITE = '#FFFFFF';

// ─── Layout Constants ────────────────────────────────────────────────────────

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Green bottom bar (§7.1) — anchors every page to the brand.
const GREEN_BAR_HEIGHT = 8;

// ─── Font Registration ───────────────────────────────────────────────────────

const FONT_BODY = 'Montserrat';
const FONT_MEDIUM = 'Montserrat-Medium';
const FONT_SEMI = 'Montserrat-SemiBold';
const FONT_BOLD = 'Montserrat-Bold';

let fontsRegistered = false;

function getAssetPath(...candidates: string[]): string | null {
    for (const rel of candidates) {
        const tries = [
            // src/services/foo.ts → ../<rel> = src/<rel>
            path.resolve(__dirname, '..', rel),
            // dist/services/foo.js → ../../src/<rel>
            path.resolve(__dirname, '../../src', rel),
            // PM2/whatever cwd → src/<rel>
            path.resolve(process.cwd(), 'src', rel),
            path.resolve(process.cwd(), rel),
        ];
        for (const p of tries) {
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

function registerFonts(doc: PDFKit.PDFDocument): void {
    if (fontsRegistered) return;
    const map: Array<[string, string]> = [
        [FONT_BODY,   'publicfiles/fonts/Montserrat-Regular.ttf'],
        [FONT_MEDIUM, 'publicfiles/fonts/Montserrat-Medium.ttf'],
        [FONT_SEMI,   'publicfiles/fonts/Montserrat-SemiBold.ttf'],
        [FONT_BOLD,   'publicfiles/fonts/Montserrat-Bold.ttf'],
    ];
    for (const [name, rel] of map) {
        const p = getAssetPath(rel);
        if (p) {
            try { doc.registerFont(name, p); } catch (err) {
                logger.warn({ err, name }, 'Font register failed; will fall back to Helvetica');
            }
        }
    }
    fontsRegistered = true;
}

/** Safe font setter — falls back to Helvetica family if Montserrat missing. */
function setFont(doc: PDFKit.PDFDocument, name: string): void {
    try {
        doc.font(name);
    } catch {
        const fallback = name.includes('Bold') ? 'Helvetica-Bold' : 'Helvetica';
        doc.font(fallback);
    }
}

/**
 * The AI-generated offer must use the 24H Group Offer logo per
 * Brand Guidelines §4.5. Fall back to the main SETT logo only if the
 * primary asset is missing.
 */
function getGroupOfferLogoPath(): string | null {
    return (
        getAssetPath('publicfiles/group-offer-header.png') ??
        getAssetPath('publicfiles/sett-logo-no-bg.png')
    );
}

/**
 * European date format (DD.MM.YYYY) per Oliver's requirement.
 * All SETT partners use this format. See src/utils/dateFormatter.ts.
 */
function formatDate(dateStr: string | null): string {
    return formatDateEU(dateStr);
}

// ─── Drawing Helpers ─────────────────────────────────────────────────────────

/** Navy hero band with the Group Offer logo + offer ref. §6.1 layout. */
function drawHeroBand(doc: PDFKit.PDFDocument, referenceNumber: number): void {
    const bandHeight = 88;

    // Solid navy band, full width.
    doc.rect(0, 0, PAGE_WIDTH, bandHeight).fillColor(NAVY).fill();

    // Logo (AI tool / group offers → Group Offer logo, §4.5).
    const logoPath = getGroupOfferLogoPath();
    if (logoPath) {
        // Source is 1875×625 (3:1). Rendered at 180 pt wide → 60 pt tall.
        // Vertically centred in the 88 pt band with a 14 pt top inset.
        try {
            doc.image(logoPath, MARGIN, 14, { width: 180 });
        } catch (err) {
            logger.warn({ err }, 'Hero logo render failed; using text fallback');
            setFont(doc, FONT_BOLD);
            doc.fontSize(22).fillColor(GREEN)
                .text('SETT HUB', MARGIN, 30);
        }
    } else {
        setFont(doc, FONT_BOLD);
        doc.fontSize(22).fillColor(GREEN)
            .text('SETT HUB', MARGIN, 30);
    }

    // Right-aligned offer title + reference number.
    setFont(doc, FONT_BOLD);
    doc.fontSize(11).fillColor(WHITE)
        .text('GROUP OFFER', MARGIN, 26, {
            width: CONTENT_WIDTH,
            align: 'right',
            characterSpacing: 1.6, // §3 — labels letter-spacing 0.1em
        });

    setFont(doc, FONT_BOLD);
    doc.fontSize(20).fillColor(GREEN)
        .text(`#${referenceNumber}`, MARGIN, 44, {
            width: CONTENT_WIDTH,
            align: 'right',
        });

    // Thin green accent stripe immediately under the band (§6.1.2).
    doc.rect(0, bandHeight, PAGE_WIDTH, 3).fillColor(GREEN).fill();
}

/** Mandatory green bottom bar on every page (§7.1 / §8.2). */
function drawGreenBottomBar(doc: PDFKit.PDFDocument): void {
    const barY = PAGE_HEIGHT - GREEN_BAR_HEIGHT;
    doc.rect(0, barY, PAGE_WIDTH, GREEN_BAR_HEIGHT).fillColor(GREEN).fill();

    // Muted legal text just above the bar. We temporarily drop the
    // bottom margin to zero so PDFKit doesn't auto-page-break this
    // small footer line, then restore.
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    try {
        setFont(doc, FONT_BODY);
        doc.fontSize(8).fillColor(GREY)
            .text(
                'S-E-T-T Worldwide Reservation FZE   ·   Confidential',
                MARGIN,
                PAGE_HEIGHT - GREEN_BAR_HEIGHT - 16,
                { width: CONTENT_WIDTH, align: 'center', lineBreak: false },
            );
    } finally {
        doc.page.margins.bottom = originalBottom;
    }
}

/** Demo badge in the SETT palette — green pill, navy text, brand letter-spacing. */
function drawDemoBadge(doc: PDFKit.PDFDocument, topY: number): void {
    const badgeWidth = 220;
    const badgeHeight = 44;
    const badgeX = (PAGE_WIDTH - badgeWidth) / 2;

    doc.roundedRect(badgeX, topY, badgeWidth, badgeHeight, 4)
        .fillColor(GREEN).fill();

    setFont(doc, FONT_BOLD);
    doc.fontSize(13).fillColor(NAVY)
        .text('DEMO  ·  PREVIEW', badgeX, topY + 14, {
            width: badgeWidth,
            align: 'center',
            characterSpacing: 1.2, // §3 — CTA letter-spacing 0.08em
        });
}

// ─── Main Generator: Demo Placeholder PDF ───────────────────────────────────

export function generateOfferPdf(data: OfferPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
                bufferPages: true,
            });

            registerFonts(doc);

            const chunks: Buffer[] = [];
            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // ── Navy hero band with Group Offer logo + ref number ────────
            drawHeroBand(doc, data.referenceNumber);

            // ── Demo badge ───────────────────────────────────────────────
            drawDemoBadge(doc, 160);

            // ── Headline ─────────────────────────────────────────────────
            setFont(doc, FONT_BOLD);
            doc.fontSize(26).fillColor(NAVY)
                .text('Your Group Offer is on its way', MARGIN, 230, {
                    width: CONTENT_WIDTH,
                    align: 'center',
                });

            // ── Subhead ──────────────────────────────────────────────────
            setFont(doc, FONT_BODY);
            doc.fontSize(12).fillColor(GREY)
                .text(
                    'The fully designed quotation document is part of the next release.',
                    MARGIN, 270,
                    { width: CONTENT_WIDTH, align: 'center' },
                );

            doc.fontSize(12).fillColor(GREY)
                .text(
                    'This preview confirms your request was received and is being processed.',
                    MARGIN, doc.y + 4,
                    { width: CONTENT_WIDTH, align: 'center' },
                );

            // ── Reference card (white surface, 3 px green left accent) ───
            const cardY = 360;
            const cardHeight = 200;

            // Card background
            doc.roundedRect(MARGIN, cardY, CONTENT_WIDTH, cardHeight, 8)
                .fillColor(BG_LIGHT).fill();

            // Left accent stripe — emphasis card pattern (§5.3)
            doc.rect(MARGIN, cardY, 3, cardHeight).fillColor(GREEN).fill();

            // Card label
            setFont(doc, FONT_SEMI);
            doc.fontSize(10).fillColor(NAVY)
                .text('REQUEST REFERENCE', MARGIN + 24, cardY + 24, {
                    width: CONTENT_WIDTH - 48,
                    characterSpacing: 1.4, // §3 labels
                });

            // Big ref number — navy, brand H2 weight
            setFont(doc, FONT_BOLD);
            doc.fontSize(28).fillColor(NAVY)
                .text(`#${data.referenceNumber}`, MARGIN + 24, cardY + 42, {
                    width: CONTENT_WIDTH - 48,
                });

            // Divider line inside card
            doc.moveTo(MARGIN + 24, cardY + 92)
                .lineTo(MARGIN + CONTENT_WIDTH - 24, cardY + 92)
                .strokeColor(BORDER).lineWidth(1).stroke();

            // Two-column metadata
            const infoY = cardY + 110;
            const col1X = MARGIN + 24;
            const col2X = MARGIN + CONTENT_WIDTH / 2 + 12;
            const labelOpts = { width: 220, characterSpacing: 1.2 };

            const drawPair = (label: string, value: string, x: number, y: number) => {
                setFont(doc, FONT_SEMI);
                doc.fontSize(8).fillColor(GREY).text(label, x, y, labelOpts);
                setFont(doc, FONT_MEDIUM);
                doc.fontSize(11).fillColor(NAVY)
                    .text(value || '—', x, y + 12, { width: 220 });
            };

            drawPair('CONTACT', data.contactName, col1X, infoY);
            drawPair('DESTINATION', data.destinationName, col2X, infoY);

            const infoY2 = infoY + 42;
            drawPair('CHECK-IN', formatDate(data.checkinDate), col1X, infoY2);
            drawPair('CHECK-OUT', formatDate(data.checkoutDate), col2X, infoY2);

            // ── Closing note ────────────────────────────────────────────
            const footNoteY = 620;
            setFont(doc, FONT_BODY);
            doc.fontSize(10).fillColor(GREY)
                .text(
                    'The complete offer document — hotel details, pricing, cancellation and payment terms —',
                    MARGIN, footNoteY,
                    { width: CONTENT_WIDTH, align: 'center' },
                );
            doc.fontSize(10).fillColor(GREY)
                .text(
                    'will be available in the next release.',
                    MARGIN, doc.y,
                    { width: CONTENT_WIDTH, align: 'center' },
                );

            // ── Issuing entity (centred, muted) ─────────────────────────
            setFont(doc, FONT_SEMI);
            doc.fontSize(9).fillColor(NAVY)
                .text(
                    data.companyName || 'S-E-T-T Worldwide Reservation FZE',
                    MARGIN, footNoteY + 50,
                    { width: CONTENT_WIDTH, align: 'center', characterSpacing: 0.8 },
                );

            // ── Per-page chrome (hero + bottom bar) ─────────────────────
            // Two-pass: paint the green bottom bar on every page that
            // exists at end-of-document, including any pages auto-created
            // by overflow. Hero is only on page 1.
            const range = doc.bufferedPageRange();
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                drawGreenBottomBar(doc);
            }

            doc.end();
        } catch (err) {
            logger.error({ err }, 'PDF generation failed');
            reject(err);
        }
    });
}
