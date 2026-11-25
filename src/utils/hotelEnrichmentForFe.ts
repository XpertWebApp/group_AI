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
    /**
     * FULL ordered fallback chain of proxy image URLs for this hotel —
     * GIATA (exterior-first priority) followed by every WBE `displayOrder`
     * key. Same chain the Add-Hotel search card uses, so the FE can
     * `<img onError>` cascade through it and land on a working photo even
     * when the GIATA "primary" is a broken placeholder. `imageUrl` is just
     * `imageUrls[0]` (kept for backward compatibility).
     */
    imageUrls: string[];
    /** Short hotel description in the requested language (EN/DE). */
    description: string | null;
    /** Brand-priority facility chip list (already capped + ordered). */
    facilities: string[];
}

/**
 * Build the FULL ordered image-URL chain for a hotel — every GIATA image
 * (exterior-first priority) followed by every WBE `displayOrder` key.
 * Mirrors the search-card chain (`hotelProbe.worker.ts:1132–1145`) so the
 * proposal card can fall back through the same list and never gets stuck on
 * a single broken GIATA "primary".
 *
 * Returns the ordered proxy-URL list (empty when the hotel has no images).
 * `imageUrls[0]` is the legacy single `imageUrl`.
 */
async function buildImageUrls(hotelCode: string): Promise<string[]> {
    try {
        const urls: string[] = [];

        // GIATA first — exterior-first priority. One URL per image row
        // (medium size; the FE thumbnail is ~160×120, no need for 4K).
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
        for (const row of sortGiataImagesByPriority(giataRows)) {
            const url =
                row.urlMedium ??
                row.urlLarge ??
                row.urlSmall ??
                row.urlFullHd ??
                row.urlOriginal ??
                null;
            if (url) urls.push(`/api/v1/hotels/giata-image?url=${encodeURIComponent(url)}`);
        }

        // WBE fallback tail — EVERY non-empty imageKey, displayOrder ASC.
        // CRITICAL: decode the stored key once before encoding for the
        // proxy. The DB stores `…Fes%3D`; the WBE CDN treats encoded vs
        // decoded as different lookups (encoded returns a placeholder).
        // The proxy route at /api/v1/hotels/image?key=… decodes via Express
        // query parsing, so we carry the decoded-then-once-encoded form —
        // same pattern as the hotelProbe worker.
        const wbeRows = await prisma.hotelImage.findMany({
            where: { hotelCode },
            select: { imageKey: true },
            orderBy: { displayOrder: 'asc' },
        });
        for (const wbeRow of wbeRows) {
            const key = wbeRow.imageKey?.trim();
            if (!key) continue;
            let decoded = key;
            try { decoded = decodeURIComponent(key); } catch { /* use as-is */ }
            urls.push(`/api/v1/hotels/image?key=${encodeURIComponent(decoded)}`);
        }

        return urls;
    } catch (err: any) {
        logger.warn(
            { err: err?.message, hotelCode },
            'buildImageUrls failed — FE will render placeholder',
        );
        return [];
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
        result.set(code, { imageUrl: null, imageUrls: [], description: null, facilities: [] });
    }

    // Reuse the PDF enrichment helper for description + facilities — same
    // queries, same brand-priority ordering. Then build image URL chains in
    // parallel since each one is a small focused query of its own.
    const [pdfEnrichment, imageChains] = await Promise.all([
        resolveHotelEnrichmentForPdf(deduped, language),
        Promise.all(deduped.map(async (code) => [code, await buildImageUrls(code)] as const)),
    ]);

    for (const code of deduped) {
        const pdf = pdfEnrichment.get(code) ?? { description: null, facilities: [] };
        const chainEntry = imageChains.find(([c]) => c === code);
        const imageUrls = chainEntry ? chainEntry[1] : [];
        result.set(code, {
            imageUrl: imageUrls[0] ?? null,
            imageUrls,
            description: pdf.description,
            facilities: pdf.facilities,
        });
    }

    return result;
}
