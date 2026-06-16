/**
 * Resolve description + facility data for PDF hotel cards.
 *
 * Sources (single batched DB pass per attribute):
 *   - description  → HotelGiataText (sectionType "100" = short description)
 *                    preferred, in the requested language; falls back to
 *                    master.Hotel.metadata.Description / .Location when
 *                    GIATA hasn't synced.
 *   - facilities   → HotelFacility → Facility.name join, ordered by
 *                    the brand priority list (Internet, Restaurant,
 *                    Air Conditioning, Bathroom, etc.) so the most
 *                    important amenities surface first in the chip
 *                    rendering.
 *
 * Returns a `hotelCode -> { description, facilities }` map. Per-hotel
 * failure is graceful: a hotel with no GIATA text and no WBE metadata
 * gets `description: null`; a hotel with no facility rows gets
 * `facilities: []`. The PDF template renders those cases by omitting
 * the relevant card sections.
 */
import { PrismaClient } from '@prisma/client';
import logger from './logger';

const prisma = new PrismaClient();

export type PdfLanguageCode = 'en' | 'de';

export interface HotelEnrichment {
    description: string | null;
    facilities: string[];
}

/**
 * Brand-priority order for facility chips. Facilities matching earlier
 * entries are pushed to the front of the chip row. Anything not on the
 * list keeps its natural order at the end. Matches what the FE
 * Add-Hotel card surfaces for "what's worth knowing first".
 */
const FACILITY_PRIORITY: ReadonlyArray<RegExp> = [
    /\binternet\b|\bwifi\b/i,
    /\brestaurant\b/i,
    /\bbar\b/i,
    /\bbreakfast\b/i,
    /\bair\s*condition/i,
    /\bbathroom\b/i,
    /\bshower\b/i,
    /\bsafe\b/i,
    /\btv\b/i,
    /\bparking\b/i,
    /\bdisabled\s*access\b|\bwheelchair\b|\baccessib/i,
    /\bpool\b/i,
    /\bgym\b|\bfitness\b/i,
    /\bspa\b/i,
];

const MAX_FACILITIES_IN_PDF = 3;

/**
 * Order a flat facility-name list by the priority regexes above. Stable
 * for ties — facilities already listed in the input order are preserved.
 */
function orderFacilities(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const pattern of FACILITY_PRIORITY) {
        for (const name of names) {
            if (seen.has(name)) continue;
            if (pattern.test(name)) {
                out.push(name);
                seen.add(name);
            }
        }
    }
    // Append everything else in its natural order.
    for (const name of names) {
        if (!seen.has(name)) {
            out.push(name);
            seen.add(name);
        }
    }
    return out.slice(0, MAX_FACILITIES_IN_PDF);
}

/**
 * Fetch GIATA short descriptions (sectionType "100") for every hotelCode
 * in the requested language. Returns a Map keyed by hotelCode. Missing
 * entries are looked up by the caller in the WBE metadata fallback.
 */
async function loadGiataDescriptions(
    hotelCodes: string[],
    language: PdfLanguageCode,
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hotelCodes.length === 0) return out;

    const rows = await prisma.hotelGiataText.findMany({
        where: {
            hotelCode: { in: hotelCodes },
            sectionType: '100',
            lang: language,
        },
        select: { hotelCode: true, content: true },
    });
    for (const row of rows) {
        if (out.has(row.hotelCode)) continue;
        const c = row.content?.trim();
        if (c) out.set(row.hotelCode, c);
    }
    return out;
}

/**
 * Fetch WBE static-data fallback descriptions from master.Hotel.metadata
 * for any hotelCode where GIATA didn't provide one. Read `Location` or
 * `Description` keys (different WBE templates use different keys for
 * what's effectively the same short-description field).
 */
async function loadWbeFallbackDescriptions(
    hotelCodes: string[],
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (hotelCodes.length === 0) return out;

    const rows = await prisma.hotel.findMany({
        where: { hotelCode: { in: hotelCodes } },
        select: { hotelCode: true, metadata: true },
    });
    for (const row of rows) {
        const m = row.metadata as Record<string, unknown> | null;
        if (!m) continue;
        const raw =
            (typeof m['Location'] === 'string' && (m['Location'] as string).trim()) ||
            (typeof m['Description'] === 'string' && (m['Description'] as string).trim()) ||
            null;
        if (raw) out.set(row.hotelCode, String(raw));
    }
    return out;
}

/**
 * Fetch the facility-name list for every hotelCode in one pass — join
 * HotelFacility → Facility, keyed back by hotelCode. Ordered later by
 * the brand priority regex.
 */
async function loadFacilities(hotelCodes: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (hotelCodes.length === 0) return out;

    for (const code of hotelCodes) out.set(code, []);

    const rows = await prisma.hotelFacility.findMany({
        where: { hotelCode: { in: hotelCodes } },
        select: { hotelCode: true, facilityId: true },
    });
    const idsNeeded = Array.from(new Set(rows.map((r) => r.facilityId)));
    if (idsNeeded.length === 0) return out;

    const facilityNames = await prisma.facility.findMany({
        where: { id: { in: idsNeeded } },
        select: { id: true, name: true },
    });
    const nameById = new Map<number, string>();
    for (const f of facilityNames) {
        const n = f.name?.trim();
        if (n) nameById.set(f.id, n);
    }

    for (const row of rows) {
        const name = nameById.get(row.facilityId);
        if (!name) continue;
        const list = out.get(row.hotelCode);
        if (list && !list.includes(name)) list.push(name);
    }

    // Order each hotel's chip list by brand priority + cap to MAX.
    for (const [code, names] of out) {
        out.set(code, orderFacilities(names));
    }
    return out;
}

/**
 * Public entry point. Returns a per-hotelCode enrichment map. Designed
 * to be called once at PDF-build time alongside `resolveHotelImagesForPdf`.
 *
 * Failure-isolated: if any individual query throws, the whole helper
 * still returns a map with empty enrichment for every hotel so the PDF
 * can render without descriptions / facilities. We log + carry on.
 */
export async function resolveHotelEnrichmentForPdf(
    hotelCodes: string[],
    language: PdfLanguageCode = 'en',
): Promise<Map<string, HotelEnrichment>> {
    const result = new Map<string, HotelEnrichment>();
    if (hotelCodes.length === 0) return result;

    const deduped = Array.from(new Set(hotelCodes.filter(Boolean)));
    for (const code of deduped) result.set(code, { description: null, facilities: [] });

    try {
        const [giataDescs, facilities] = await Promise.all([
            loadGiataDescriptions(deduped, language),
            loadFacilities(deduped),
        ]);

        // Compute which hotels still need the WBE fallback for description.
        const needWbeFallback = deduped.filter((c) => !giataDescs.has(c));
        const wbeDescs = await loadWbeFallbackDescriptions(needWbeFallback);

        for (const code of deduped) {
            result.set(code, {
                description: giataDescs.get(code) ?? wbeDescs.get(code) ?? null,
                facilities: facilities.get(code) ?? [],
            });
        }
    } catch (err: any) {
        logger.warn(
            { err: err?.message, language, hotelCount: deduped.length },
            'resolveHotelEnrichmentForPdf failed — PDF will render without descriptions / facilities',
        );
    }

    return result;
}
