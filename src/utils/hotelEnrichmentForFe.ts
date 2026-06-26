/**
 * Hotel enrichment for the FE proposal endpoint.
 *
 * Sister helper to `hotelEnrichmentForPdf.ts`. Returns the SAME shape
 * conceptually (description + facilities + primary image), but with
 * one critical difference: images are returned as **proxy URLs**
 * (`/api/v1/hotels/image?key=…` or `/api/v1/hotels/giata-image?url=…`)
 * instead of inlined data URIs.
 *
 * Why two helpers:
 *  - PDF render needs self-contained data URIs because the emailed PDF
 *    must work offline / without back-channel access to our image
 *    proxy. Worth the fetch cost at PDF build time.
 *  - FE render needs URL references because (a) it's an HTML page, the
 *    browser can fetch via `<img src>` on demand, (b) a 50-hotel JSON
 *    payload with inlined images would be ~15 MB; with URL references
 *    it's a few KB.
 *
 * GIATA priority + WBE fallback mirrors the FE Add-Hotel card chain so
 * the same hotel renders the same image in both places.
 */
import { PrismaClient } from '@prisma/client';
import logger from './logger';
import { sortGiataImagesByPriority } from '../config/imagePriority';
import {
    resolveHotelEnrichmentForPdf,
    type PdfLanguageCode,
} from './hotelEnrichmentForPdf';

const prisma = new PrismaClient();

export interface FeHotelEnrichment {
    /**
     * Proxy URL the FE can drop straight into `<img src>`. Null when
     * the hotel has neither a GIATA image nor a WBE imageKey in our
     * database. The FE renders a placeholder card in that case.
     *
     * Format:
     *   GIATA → `/api/v1/hotels/giata-image?url=<encoded-giata-url>`
     *   WBE   → `/api/v1/hotels/image?key=<url-encoded-wbe-key>`
     */
    imageUrl: string | null;
    /** Short hotel description in the requested language (EN/DE). */
    description: string | null;
    /** Brand-priority facility chip list (already capped + ordered). */
    facilities: string[];
}

/**
 * Build the primary image URL for a hotel — GIATA first, WBE fallback.
 * Mirrors the priority chain used in `hotelProbe.worker.ts:1132–1145`
 * so the FE proposal card shows the same image as the FE Add-Hotel card.
 *
 * Returns the proxy URL string, or null when the hotel has no images.
 */
async function buildImageUrl(hotelCode: string): Promise<string | null> {
    try {
        // GIATA preferred — exterior-first priority, smallest size variant
        // first (the FE will use ~160×120 max, no need for 4K).
        const giataRows = await prisma.hotelGiataImage.findMany({
            where: { hotelCode },
            select: {
                imageType: true,
                displayOrder: true,
                urlSmall: true,
                urlMedium: true,
                urlLarge: true,
                urlFullHd: true,
                urlOriginal: true,
            },
        });
        if (giataRows.length > 0) {
            const sorted = sortGiataImagesByPriority(giataRows);
            for (const row of sorted) {
                const url =
                    row.urlMedium ??
                    row.urlLarge ??
                    row.urlSmall ??
                    row.urlFullHd ??
                    row.urlOriginal ??
                    null;
                if (url) {
                    return `/api/v1/hotels/giata-image?url=${encodeURIComponent(url)}`;
                }
            }
        }

        // WBE fallback — pick the lowest-displayOrder non-empty imageKey.
        // CRITICAL: decode the stored key once before encoding for the
        // proxy. The DB stores `…Fes%3D`; the WBE CDN treats encoded vs
        // decoded as different lookups (encoded returns a placeholder).
        // The proxy route at /api/v1/hotels/image?key=… already decodes
        // via Express query parsing, so we want our URL to carry the
        // decoded form once-encoded — same pattern as hotelProbe worker.
        const wbeRow = await prisma.hotelImage.findFirst({
            where: { hotelCode },
            select: { imageKey: true },
            orderBy: { displayOrder: 'asc' },
        });
        if (wbeRow?.imageKey) {
            let decoded = wbeRow.imageKey;
            try { decoded = decodeURIComponent(wbeRow.imageKey); } catch { /* use as-is */ }
            return `/api/v1/hotels/image?key=${encodeURIComponent(decoded)}`;
        }

        return null;
    } catch (err: any) {
        logger.warn(
            { err: err?.message, hotelCode },
            'buildImageUrl failed — FE will render placeholder',
        );
        return null;
    }
}

/**
 * Resolve a `hotelCode -> FeHotelEnrichment` map for every hotel in
 * a proposal. Called once by `proposals.service.getProposalById()`
 * after the proposal row is loaded.
 *
 * Image URLs are constructed in parallel (per-hotel); description +
 * facilities reuse the PDF-side helper since the data path is
 * identical.
 */
export async function resolveHotelEnrichmentForFe(
    hotelCodes: string[],
    language: PdfLanguageCode = 'en',
): Promise<Map<string, FeHotelEnrichment>> {
    const result = new Map<string, FeHotelEnrichment>();
    if (hotelCodes.length === 0) return result;

    const deduped = Array.from(new Set(hotelCodes.filter(Boolean)));
    for (const code of deduped) {
        result.set(code, { imageUrl: null, description: null, facilities: [] });
    }

    // Reuse the PDF enrichment helper for description + facilities — same
    // queries, same brand-priority ordering. Then build image URLs in
    // parallel since each one is a small focused query of its own.
    const [pdfEnrichment, imageUrls] = await Promise.all([
        resolveHotelEnrichmentForPdf(deduped, language),
        Promise.all(deduped.map(async (code) => [code, await buildImageUrl(code)] as const)),
    ]);

    for (const code of deduped) {
        const pdf = pdfEnrichment.get(code) ?? { description: null, facilities: [] };
        const urlEntry = imageUrls.find(([c]) => c === code);
        const imageUrl = urlEntry ? urlEntry[1] : null;
        result.set(code, {
            imageUrl,
            description: pdf.description,
            facilities: pdf.facilities,
        });
    }

    return result;
}
