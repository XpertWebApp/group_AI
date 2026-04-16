"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOfferPdf = generateOfferPdf;
const pdfkit_1 = __importDefault(require("pdfkit"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = __importDefault(require("../utils/logger"));
const dateFormatter_1 = require("../utils/dateFormatter");
// ─── Brand Colors ────────────────────────────────────────────────────────────
const NAVY = '#071C42';
const GREEN = '#AAC737';
const GREY = '#686868';
const LIGHT_GREY = '#999999';
const WHITE = '#FFFFFF';
const LIGHT_BG = '#F5F5F5';
// ─── Layout Constants ────────────────────────────────────────────────────────
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
// ─── Helpers ─────────────────────────────────────────────────────────────────
function getLogoPath() {
    const candidates = [
        path_1.default.resolve(__dirname, '../publicfiles/Figma/SETT_logo.png'),
        path_1.default.resolve(__dirname, '../../src/publicfiles/Figma/SETT_logo.png'),
        path_1.default.resolve(process.cwd(), 'src/publicfiles/Figma/SETT_logo.png'),
    ];
    for (const p of candidates) {
        if (fs_1.default.existsSync(p))
            return p;
    }
    return null;
}
/**
 * European date format (DD.MM.YYYY) per Oliver's requirement.
 * All SETT partners use this format. See src/utils/dateFormatter.ts.
 */
function formatDate(dateStr) {
    return (0, dateFormatter_1.formatDateEU)(dateStr);
}
// ─── Main Generator: Demo Placeholder PDF ───────────────────────────────────
function generateOfferPdf(data) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new pdfkit_1.default({
                size: 'A4',
                margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
            });
            const chunks = [];
            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            // ── Header logo ──────────────────────────────────────────────
            const logoPath = getLogoPath();
            if (logoPath) {
                doc.image(logoPath, MARGIN, MARGIN, { width: 110 });
            }
            else {
                doc.fontSize(24).font('Helvetica-Bold').fillColor(GREEN)
                    .text('SETT', MARGIN, MARGIN + 8);
            }
            // ── Top accent bar ───────────────────────────────────────────
            doc.rect(MARGIN, MARGIN + 70, CONTENT_WIDTH, 3).fillColor(NAVY).fill();
            // ── Centered "DEMO PDF" badge ────────────────────────────────
            const badgeY = 180;
            const badgeWidth = 280;
            const badgeHeight = 50;
            const badgeX = (PAGE_WIDTH - badgeWidth) / 2;
            doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 8)
                .fillColor(GREEN).fill();
            doc.fontSize(22).font('Helvetica-Bold').fillColor(WHITE)
                .text('DEMO PDF', badgeX, badgeY + 14, {
                width: badgeWidth,
                align: 'center',
            });
            // ── Main message ─────────────────────────────────────────────
            doc.fontSize(28).font('Helvetica-Bold').fillColor(NAVY)
                .text('Coming Soon', MARGIN, badgeY + 90, {
                width: CONTENT_WIDTH,
                align: 'center',
            });
            doc.moveDown(0.6);
            doc.fontSize(13).font('Helvetica').fillColor(GREY)
                .text('The full quotation PDF design is part of the next milestone.', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
            doc.moveDown(0.4);
            doc.fontSize(13).font('Helvetica').fillColor(GREY)
                .text('This is a placeholder document for preview and testing purposes only.', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
            // ── Reference info card ──────────────────────────────────────
            const cardY = 420;
            const cardHeight = 160;
            doc.roundedRect(MARGIN, cardY, CONTENT_WIDTH, cardHeight, 6)
                .fillColor(LIGHT_BG).fill();
            doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY)
                .text('REQUEST REFERENCE', MARGIN + 24, cardY + 20, {
                width: CONTENT_WIDTH - 48,
            });
            doc.fontSize(20).font('Helvetica-Bold').fillColor(NAVY)
                .text(`#${data.referenceNumber}`, MARGIN + 24, cardY + 36, {
                width: CONTENT_WIDTH - 48,
            });
            // Two-column layout for basic info
            const infoY = cardY + 80;
            const col1X = MARGIN + 24;
            const col2X = MARGIN + (CONTENT_WIDTH / 2) + 12;
            doc.fontSize(8).font('Helvetica-Bold').fillColor(LIGHT_GREY)
                .text('CONTACT', col1X, infoY, { width: 200 });
            doc.fontSize(10).font('Helvetica').fillColor(NAVY)
                .text(data.contactName || '-', col1X, infoY + 12, { width: 200 });
            doc.fontSize(8).font('Helvetica-Bold').fillColor(LIGHT_GREY)
                .text('DESTINATION', col2X, infoY, { width: 200 });
            doc.fontSize(10).font('Helvetica').fillColor(NAVY)
                .text(data.destinationName || '-', col2X, infoY + 12, { width: 200 });
            const infoY2 = infoY + 36;
            doc.fontSize(8).font('Helvetica-Bold').fillColor(LIGHT_GREY)
                .text('CHECK-IN', col1X, infoY2, { width: 200 });
            doc.fontSize(10).font('Helvetica').fillColor(NAVY)
                .text(formatDate(data.checkinDate), col1X, infoY2 + 12, { width: 200 });
            doc.fontSize(8).font('Helvetica-Bold').fillColor(LIGHT_GREY)
                .text('CHECK-OUT', col2X, infoY2, { width: 200 });
            doc.fontSize(10).font('Helvetica').fillColor(NAVY)
                .text(formatDate(data.checkoutDate), col2X, infoY2 + 12, { width: 200 });
            // ── Footer note ──────────────────────────────────────────────
            const footerY = 700;
            doc.moveTo(MARGIN, footerY)
                .lineTo(MARGIN + CONTENT_WIDTH, footerY)
                .strokeColor('#E0E0E0').lineWidth(0.5).stroke();
            doc.fontSize(9).font('Helvetica-Oblique').fillColor(LIGHT_GREY)
                .text('The complete offer document with hotel details, pricing, terms and conditions', MARGIN, footerY + 14, { width: CONTENT_WIDTH, align: 'center' });
            doc.fontSize(9).font('Helvetica-Oblique').fillColor(LIGHT_GREY)
                .text('will be available in the next release.', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
            // ── Bottom company line ──────────────────────────────────────
            doc.fontSize(8).font('Helvetica').fillColor(LIGHT_GREY)
                .text(data.companyName || 'S-E-T-T Worldwide Reservation FZE', MARGIN, PAGE_HEIGHT - 50, { width: CONTENT_WIDTH, align: 'center' });
            doc.end();
        }
        catch (err) {
            logger_1.default.error({ err }, 'PDF generation failed');
            reject(err);
        }
    });
}
