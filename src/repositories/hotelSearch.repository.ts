import { PrismaClient, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { pickBestGiataImage, sortGiataImagesByPriority } from '../config/imagePriority';
import { YOUTH_FRIENDLY_NAME_PATTERNS } from '../config/youthFriendlyPatterns';
import { buildSethubDetailsUrl } from '../config/sethubUrl';
import {
    resolveMultiLangDescriptions,
    pickLegacyDescription,
    GIATA_LOCATION_SECTION,
    type SupportedLang,
    type MultiLangDescriptions,
} from '../utils/hotelDescription';
import { translateTextsFree } from '../utils/freeTranslate';

const prisma = new PrismaClient();

/**
 * In-process cache of German translations of the WBE "Important Information"
 * (EssentialInfo) text, keyed by the source English string. WBE serves this
 * field only in English and the same boilerplate repeats across thousands of
 * hotels, so we translate each UNIQUE string once (via the free
 * google-translate-api-x — NOT DeepL) and reuse it, avoiding a translate call
 * on every status poll. Cleared on process restart.
 */
const ESSENTIAL_INFO_DE_CACHE = new Map<string, string>();

export interface HotelCodeRow {
    hotelCode: string;
    name: string;
    starRating: Decimal | null;
    destinationId: number | null;
    addressCity: string | null;
    addressCountry: string | null;
    latitude: Decimal | null;
    longitude: Decimal | null;
    /** Physical room count from WBE static data. Used for Step 3.2 inventory overlap check. */
    totalRooms?: number | null;
    /** Primary image key (lowest displayOrder with a non-empty imageKey). */
    primaryImageKey?: string | null;
    /**
     * Every non-empty WBE imageKey for the hotel, ordered by displayOrder ASC.
     * Used by the FE as a fallback chain: when the proxy returns 404/blank
     * for the primary key (some WBE rows have a key but the CDN has no
     * actual image bytes), the FE walks the rest of the list until one
     * resolves. Empty array when the hotel has no WBE images.
     */
    allImageKeys?: string[];
    /**
     * Direct GIATA CDN URL for the best-matched categorised image (priority:
     * exterior → room → lobby → others). Preferred over primaryImageKey.
     * Null when the hotel has no GIATA images synced yet.
     */
    giataImageUrl?: string | null;
    /**
     * Every GIATA categorised image URL for the hotel in picker-priority
     * order. Same fallback purpose as `allImageKeys` — lets the FE try
     * the next-best GIATA image when the top pick fails to load.
     */
    giataImageUrls?: string[];
    /** SETTHub numeric hotel ID used to build the public detail page URL. */
    masterHotelId?: number | null;
    /**
     * Full SETTHub hotel-detail URL (e.g. https://booking.s-e-t-t.com/Availability/Hotel/Details/<b64>).
     * Null when masterHotelId is missing — frontend should render the hotel
     * name as plain text in that case.
     */
    sethubDetailsUrl?: string | null;
    /** Short description, in the requested language when GIATA has it, else WBE English fallback. */
    description?: string | null;
    /** Actual language of the returned description — may differ from requested on WBE fallback. */
    descriptionLanguage?: SupportedLang | null;
    /** 'giata' when the text came from GIATA MHG, 'wbe' on metadata fallback, null when nothing was found. */
    descriptionSource?: 'giata' | 'wbe' | null;
    /**
     * Both supported translations of the description in one payload so the
     * FE can swap text instantly when the user toggles the language switcher
     * without re-running the search. Always present on results from
     * getHotelsByCode().
     */
    descriptions?: MultiLangDescriptions;
}

export class HotelSearchRepository {
    /**
     * Returns hotel codes for a given destination, filtered by star ratings.
     * Used to build the HotelIds list for the WBE search call.
     */
    async getHotelCodesByDestination(
        destinationId: number,
        starRatings: number[],
        limit = 200,
        offset = 0,
        options: { prioritiseYouthFriendly?: boolean } = {},
    ): Promise<HotelCodeRow[]> {
        // Youth / school group requests promote hotels whose names match the
        // multilingual youth-friendly pattern list to the FRONT of the
        // pagination queue. This is not a filter — every hotel is still
        // probed in subsequent batches; we just reach the youth-friendly
        // inventory first so the auto-offer's TARGET_VIABLE_HOTELS quota
        // fills with hostels / guesthouses / Jugendherbergen before
        // pagination stops. Required because high-`total_rooms` hotels
        // (chain hotels) dominate the default ordering and youth-friendly
        // inventory typically has NULL total_rooms (pushed to the tail by
        // `NULLS LAST`).
        if (options.prioritiseYouthFriendly) {
            return this.getHotelCodesByDestinationRaw(destinationId, starRatings, limit, offset);
        }

        const select = {
            hotelCode: true,
            name: true,
            starRating: true,
            destinationId: true,
            addressCity: true,
            addressCountry: true,
            latitude: true,
            longitude: true,
            totalRooms: true,
        };

        // Stable ORDER BY: larger hotels first (more supply per WBE call) with
        // hotelCode as the tiebreaker so paginated batches never overlap or skip.
        // Pre-existing limit-only callers stay backwards-compatible because
        // ordering doesn't change semantics for them — just makes results
        // deterministic across runs.
        const orderBy = [
            { totalRooms: { sort: 'desc', nulls: 'last' } } as const,
            { hotelCode: 'asc' } as const,
        ];

        if (starRatings.length === 0) {
            return prisma.hotel.findMany({
                where: { destinationId },
                select,
                orderBy,
                take: limit,
                skip: offset,
            });
        }

        return prisma.hotel.findMany({
            where: {
                destinationId,
                OR: starRatings.flatMap((star) => [
                    { starRating: { gte: new Decimal(star - 0.5), lte: new Decimal(star + 0.5) } },
                ]),
            },
            select,
            orderBy,
            take: limit,
            skip: offset,
        });
    }

    /**
     * Raw SQL variant of `getHotelCodesByDestination` used ONLY when
     * `prioritiseYouthFriendly: true`. Adds a leading ORDER BY tier that
     * sorts youth-friendly hotels (by name match against the shared
     * pattern list) before non-friendly ones, then falls back to the
     * standard `total_rooms DESC NULLS LAST, hotel_code ASC` ordering.
     *
     * Returns rows shaped to match `HotelCodeRow` so callers don't have
     * to discriminate on which path produced the result.
     */
    private async getHotelCodesByDestinationRaw(
        destinationId: number,
        starRatings: number[],
        limit: number,
        offset: number,
    ): Promise<HotelCodeRow[]> {
        // Build the youth-friendly CASE expression: 0 when ANY pattern matches
        // (lowercased substring), 1 otherwise. ANDed via OR of LIKE clauses.
        const yfClauses = Prisma.join(
            YOUTH_FRIENDLY_NAME_PATTERNS.map(
                (p) => Prisma.sql`LOWER(name) LIKE ${'%' + p + '%'}`,
            ),
            ' OR ',
        );

        // Star-rating WHERE — match the half-star ±0.5 logic from the
        // Prisma path exactly. If starRatings is empty, the clause is TRUE.
        const starClause = starRatings.length === 0
            ? Prisma.sql`TRUE`
            : Prisma.join(
                starRatings.map(
                    (star) => Prisma.sql`(star_rating >= ${star - 0.5} AND star_rating <= ${star + 0.5})`,
                ),
                ' OR ',
            );

        const rows = await prisma.$queryRaw<Array<{
            hotelCode: string;
            name: string;
            starRating: Decimal | null;
            destinationId: number | null;
            addressCity: string | null;
            addressCountry: string | null;
            latitude: Decimal | null;
            longitude: Decimal | null;
            totalRooms: number | null;
        }>>`
            SELECT
                hotel_code           AS "hotelCode",
                name,
                star_rating          AS "starRating",
                destination_id       AS "destinationId",
                address_city         AS "addressCity",
                address_country      AS "addressCountry",
                latitude,
                longitude,
                total_rooms          AS "totalRooms"
            FROM master.hotels
            WHERE destination_id = ${destinationId}
              AND (${starClause})
            ORDER BY
                CASE WHEN (${yfClauses}) THEN 0 ELSE 1 END ASC,
                total_rooms DESC NULLS LAST,
                hotel_code ASC
            LIMIT ${limit} OFFSET ${offset};
        `;

        return rows;
    }

    /**
     * Count the total hotels matching a destination + star-rating filter.
     * Used by the pagination orchestrator to detect "destination exhausted"
     * without fetching an empty batch. Mirrors the WHERE clause of
     * getHotelCodesByDestination() exactly.
     */
    async countHotelsByDestination(
        destinationId: number,
        starRatings: number[],
    ): Promise<number> {
        if (starRatings.length === 0) {
            return prisma.hotel.count({ where: { destinationId } });
        }
        return prisma.hotel.count({
            where: {
                destinationId,
                OR: starRatings.flatMap((star) => [
                    { starRating: { gte: new Decimal(star - 0.5), lte: new Decimal(star + 0.5) } },
                ]),
            },
        });
    }

    // ─── Destination hierarchy helpers — for "never say no" fallback ────────

    /**
     * Returns the chain of ancestor destinationIds (parent → grandparent → … → root).
     * Used by the search-relaxation pipeline to widen from exact area → parent → country.
     * Caps depth at 6 to avoid runaway loops on malformed data.
     */
    async getDestinationAncestry(destinationId: number): Promise<number[]> {
        const out: number[] = [];
        let cur = destinationId;
        for (let depth = 0; depth < 6; depth++) {
            const row = await prisma.destination.findUnique({
                where: { id: cur },
                select: { parentId: true },
            });
            if (!row?.parentId || out.includes(row.parentId)) break;
            out.push(row.parentId);
            cur = row.parentId;
        }
        return out;
    }

    /**
     * Returns the country-level destinationId (top of the ancestry chain).
     * If the destination has no parent, returns null (it might already be the country).
     */
    async getCountryDestinationId(destinationId: number): Promise<number | null> {
        const ancestry = await this.getDestinationAncestry(destinationId);
        if (ancestry.length === 0) return null;
        return ancestry[ancestry.length - 1] ?? null;
    }

    /**
     * Look up a destination's display name. Used to build banner messages
     * when the search falls back to a wider destination.
     */
    async getDestinationName(destinationId: number): Promise<string | null> {
        const row = await prisma.destination.findUnique({
            where: { id: destinationId },
            select: { name: true },
        });
        return row?.name ?? null;
    }

    /**
     * Sibling destinations within the same country, ranked by hotel-cluster
     * proximity to the original destination. Destination has no lat/lng, so
     * we use the centroid of the destination's hotels as the reference point.
     * Returns up to maxResults destination IDs, nearest first.
     */
    async getNearbyDestinations(destinationId: number, maxResults = 5): Promise<number[]> {
        const dest = await prisma.destination.findUnique({
            where: { id: destinationId },
            select: { countryCode: true },
        });
        if (!dest?.countryCode) return [];

        const center = await prisma.hotel.aggregate({
            where: { destinationId, latitude: { not: null }, longitude: { not: null } },
            _avg: { latitude: true, longitude: true },
        });
        const lat = center._avg.latitude ? Number(center._avg.latitude) : null;
        const lng = center._avg.longitude ? Number(center._avg.longitude) : null;
        if (lat == null || lng == null) return [];

        const rows = await prisma.$queryRaw<{ id: number }[]>`
            SELECT d.id
            FROM master.destinations d
            WHERE d.country_code = ${dest.countryCode}
              AND d.id <> ${destinationId}
              AND EXISTS (
                  SELECT 1 FROM master.hotels h
                  WHERE h.destination_id = d.id AND h.latitude IS NOT NULL
              )
            ORDER BY (
              SELECT MIN(POWER(h.latitude - ${lat}, 2) + POWER(h.longitude - ${lng}, 2))
              FROM master.hotels h
              WHERE h.destination_id = d.id AND h.latitude IS NOT NULL
            ) ASC
            LIMIT ${maxResults};
        `;
        return rows.map((r) => Number(r.id));
    }

    /**
     * Returns a map of hotelCode → hotel info for enriching search results.
     * Includes the primary image key (displayOrder=0) from HotelImage if available.
     */
    async getHotelsByCode(
        hotelCodes: string[],
        lang: SupportedLang = 'en',
    ): Promise<Map<string, HotelCodeRow>> {
        if (hotelCodes.length === 0) return new Map();

        const [hotels, images, giataImages, giataTexts] = await Promise.all([
            prisma.hotel.findMany({
                where: { hotelCode: { in: hotelCodes } },
                select: {
                    hotelCode: true,
                    name: true,
                    starRating: true,
                    destinationId: true,
                    addressCity: true,
                    addressCountry: true,
                    latitude: true,
                    longitude: true,
                    totalRooms: true,
                    masterHotelId: true,
                    metadata: true,
                },
            }),
            // Fetch all WBE image rows for the requested hotels ordered by
            // displayOrder ASC. We then pick the first row with a non-empty
            // imageKey per hotel in the JS layer below. Previously we
            // hard-pinned displayOrder=0, which silently failed for hotels
            // whose row at index 0 had a blank/missing imageKey but had
            // perfectly good images at indexes 1, 2, 3… (Oliver flagged
            // multiple Samui / Chaweng hotels showing as blank cards even
            // though their detail dialog had 30+ images).
            prisma.hotelImage.findMany({
                where: { hotelCode: { in: hotelCodes } },
                select: { hotelCode: true, imageKey: true, displayOrder: true },
                orderBy: { displayOrder: 'asc' },
            }),
            // GIATA categorised images — preferred over WBE's first image.
            // Pick widest size available per image; picker below prefers 4K > FullHD > large > medium > small.
            prisma.hotelGiataImage.findMany({
                where: { hotelCode: { in: hotelCodes } },
                select: {
                    hotelCode: true,
                    imageType: true,
                    displayOrder: true,
                    urlSmall: true,
                    urlMedium: true,
                    urlLarge: true,
                    urlFullHd: true,
                    urlOriginal: true,
                },
            }),
            // GIATA short location description in BOTH supported languages —
            // we always return both so the FE can switch languages instantly
            // without re-running the search. Section type '100' = Lage /
            // Location — short summary suitable for cards.
            prisma.hotelGiataText.findMany({
                where: {
                    hotelCode: { in: hotelCodes },
                    lang: { in: ['en', 'de'] },
                    sectionType: GIATA_LOCATION_SECTION,
                },
                select: { hotelCode: true, lang: true, content: true },
            }),
        ]);

        // Collect EVERY non-empty WBE imageKey per hotel, preserving the
        // displayOrder ASC ordering (rows already arrived sorted from the
        // SQL query). The first entry in each list is the "primary" key;
        // the rest are fallbacks the FE walks through on load failure.
        const imageKeysByHotel = new Map<string, string[]>();
        for (const img of images) {
            const key = img.imageKey?.trim();
            if (!key) continue;
            const list = imageKeysByHotel.get(img.hotelCode) ?? [];
            list.push(key);
            imageKeysByHotel.set(img.hotelCode, list);
        }
        const imageMap = new Map<string, string>();
        for (const [code, list] of imageKeysByHotel) imageMap.set(code, list[0]!);

        // Group GIATA images by hotelCode so we can pick the best one per hotel.
        const giataByHotel = new Map<string, typeof giataImages>();
        for (const img of giataImages) {
            const arr = giataByHotel.get(img.hotelCode) ?? [];
            arr.push(img);
            giataByHotel.set(img.hotelCode, arr);
        }

        // Map hotelCode → { en, de } GIATA section-100 content.
        const giataTextByHotel = new Map<string, { en: string | null; de: string | null }>();
        for (const t of giataTexts) {
            const existing = giataTextByHotel.get(t.hotelCode) ?? { en: null, de: null };
            if (t.lang === 'en' || t.lang === 'de') existing[t.lang] = t.content;
            giataTextByHotel.set(t.hotelCode, existing);
        }

        const map = new Map<string, HotelCodeRow>();
        for (const h of hotels) {
            const meta = h.metadata as Record<string, any> | null;
            const bundles = resolveMultiLangDescriptions(
                giataTextByHotel.get(h.hotelCode) ?? { en: null, de: null },
                meta,
            );
            // Keep the legacy single-language fields populated so existing FE
            // code paths (and downstream consumers like the proposal builder)
            // keep working unchanged.
            const resolved = pickLegacyDescription(bundles, lang);

            // Sort every GIATA image for this hotel by Oliver's priority
            // (exterior → room → lobby → ...) and convert each to its widest
            // available size URL wrapped in our auth proxy. The first entry
            // is the "primary" GIATA image; the rest are fallbacks.
            const sortedGiata = sortGiataImagesByPriority(giataByHotel.get(h.hotelCode) ?? []);
            const pickWidestSize = (img: typeof sortedGiata[number]): string | null =>
                img.urlOriginal ?? img.urlFullHd ?? img.urlLarge ?? img.urlMedium ?? img.urlSmall ?? null;
            const giataImageUrls = sortedGiata
                .map(pickWidestSize)
                .filter((u): u is string => !!u)
                .map((u) => `/api/v1/hotels/giata-image?url=${encodeURIComponent(u)}`);
            const giataImageUrl = giataImageUrls[0] ?? null;
            // Kept for any callers that still read pickBestGiataImage's result
            // shape; new callers should consume `giataImageUrls`.
            void pickBestGiataImage;

            const { metadata: _meta, ...hotelFields } = h;
            map.set(h.hotelCode, {
                ...hotelFields,
                primaryImageKey: imageMap.get(h.hotelCode) ?? null,
                allImageKeys: imageKeysByHotel.get(h.hotelCode) ?? [],
                giataImageUrl,
                giataImageUrls,
                sethubDetailsUrl: buildSethubDetailsUrl(h.masterHotelId),
                description: resolved.description,
                descriptionLanguage: resolved.descriptionLanguage,
                descriptionSource: resolved.descriptionSource,
                descriptions: bundles,
            });
        }
        return map;
    }

    /**
     * Returns a map of hotelCode → facility list (id + name) for the given hotel codes.
     * Used to enrich hotel probe results with amenity data.
     */
    async getFacilitiesByHotelCodes(
        hotelCodes: string[],
    ): Promise<Map<string, Array<{ id: number; name: string }>>> {
        if (hotelCodes.length === 0) return new Map();

        const rows = await prisma.hotelFacility.findMany({
            where: { hotelCode: { in: hotelCodes } },
            select: { hotelCode: true, facilityId: true },
        });

        // Collect unique facility IDs
        const facilityIds = [...new Set(rows.map((r) => r.facilityId))];
        if (facilityIds.length === 0) return new Map();

        const facilities = await prisma.facility.findMany({
            where: { id: { in: facilityIds } },
            select: { id: true, name: true },
        });

        const facilityMap = new Map<number, string>();
        for (const f of facilities) facilityMap.set(f.id, f.name);

        const result = new Map<string, Array<{ id: number; name: string }>>();
        for (const row of rows) {
            const name = facilityMap.get(row.facilityId);
            if (!name) continue;
            if (!result.has(row.hotelCode)) result.set(row.hotelCode, []);
            result.get(row.hotelCode)!.push({ id: row.facilityId, name });
        }

        return result;
    }

    /**
     * Returns all master facilities (for filter sidebar).
     */
    async getAllFacilities(): Promise<Array<{ id: number; name: string }>> {
        return prisma.facility.findMany({
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
        });
    }

    /**
     * Returns facilities available for hotels in a given destination.
     * Useful for showing only relevant filter options.
     */
    async getFacilitiesByDestination(
        destinationId: number,
    ): Promise<Array<{ id: number; name: string; hotelCount: number }>> {
        // Get hotel codes for this destination
        const hotels = await prisma.hotel.findMany({
            where: { destinationId },
            select: { hotelCode: true },
        });
        const hotelCodes = hotels.map((h) => h.hotelCode);
        if (hotelCodes.length === 0) return [];

        // Get facility IDs linked to these hotels with counts
        const hotelFacilities = await prisma.hotelFacility.findMany({
            where: { hotelCode: { in: hotelCodes } },
            select: { facilityId: true, hotelCode: true },
        });

        // Count hotels per facility
        const facilityHotelMap = new Map<number, Set<string>>();
        for (const hf of hotelFacilities) {
            if (!facilityHotelMap.has(hf.facilityId)) facilityHotelMap.set(hf.facilityId, new Set());
            facilityHotelMap.get(hf.facilityId)!.add(hf.hotelCode);
        }

        const facilityIds = [...facilityHotelMap.keys()];
        if (facilityIds.length === 0) return [];

        const facilities = await prisma.facility.findMany({
            where: { id: { in: facilityIds } },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
        });

        return facilities.map((f) => ({
            id: f.id,
            name: f.name,
            hotelCount: facilityHotelMap.get(f.id)?.size ?? 0,
        }));
    }

    /**
     * Returns hotel codes from the given list that have ALL of the specified facility IDs.
     * Used for amenity filtering in hotel search.
     */
    async filterHotelCodesByFacilities(
        hotelCodes: string[],
        facilityIds: number[],
    ): Promise<string[]> {
        if (hotelCodes.length === 0 || facilityIds.length === 0) return hotelCodes;

        const rows = await prisma.hotelFacility.findMany({
            where: {
                hotelCode: { in: hotelCodes },
                facilityId: { in: facilityIds },
            },
            select: { hotelCode: true, facilityId: true },
        });

        // Group by hotel code and check each has ALL requested facilities
        const hotelFacilityMap = new Map<string, Set<number>>();
        for (const r of rows) {
            if (!hotelFacilityMap.has(r.hotelCode)) hotelFacilityMap.set(r.hotelCode, new Set());
            hotelFacilityMap.get(r.hotelCode)!.add(r.facilityId);
        }

        return hotelCodes.filter((code) => {
            const facilities = hotelFacilityMap.get(code);
            if (!facilities) return false;
            return facilityIds.every((id) => facilities.has(id));
        });
    }

    /**
     * Returns a cached option detail by TID, or null if not found / expired.
     */
    async getCachedOptionDetail(tid: string) {
        return prisma.hotelOptionDetail.findUnique({
            where: { tid },
        });
    }

    /**
     * Batched lookup of the "Important Information" (WBE EssentialInfo) for a set
     * of hotels, from the option-detail cache. Returns hotelCode -> essentialInfo
     * for the most-recently-fetched cached option that HAS a non-empty value.
     *
     * Used by the hotel-search status endpoint to re-hydrate `essentialInfo`
     * onto jobs whose `resultJson` was persisted before the field was added to
     * the worker output — mirrors how images/descriptions are re-resolved.
     */
    async getEssentialInfoByHotelCodes(
        hotelCodes: string[],
        language: 'en' | 'de' = 'en',
    ): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        const codes = Array.from(new Set(hotelCodes.filter(Boolean)));
        if (codes.length === 0) return out;
        const rows = await prisma.hotelOptionDetail.findMany({
            where: { hotelCode: { in: codes }, essentialInfo: { not: null } },
            select: { hotelCode: true, essentialInfo: true },
            orderBy: { fetchedAt: 'desc' },
        });
        for (const r of rows) {
            const code = r.hotelCode;
            const info = r.essentialInfo?.trim();
            if (code && info && !out.has(code)) out.set(code, info); // first = most recent
        }
        // WBE serves EssentialInfo only in English — translate to German on demand
        // (deduped + cached, via the free google-translate-api-x, NOT DeepL).
        // Translation failures fall back to the original English.
        if (language === 'de') await this.translateEssentialInfoMapToDe(out);
        return out;
    }

    /** Translate the values of a hotelCode→EssentialInfo map to German in place. */
    private async translateEssentialInfoMapToDe(map: Map<string, string>): Promise<void> {
        const uncached = Array.from(new Set(
            Array.from(map.values()).filter((v) => !ESSENTIAL_INFO_DE_CACHE.has(v)),
        ));
        // Small chunks keep each request light AND limit the blast radius of a
        // single failed request (fewer hotels affected). Cap by count + chars.
        const MAX_TEXTS = 8;
        const MAX_CHARS = 12_000;
        let i = 0;
        while (i < uncached.length) {
            const chunk: string[] = [];
            let chars = 0;
            while (
                i < uncached.length
                && chunk.length < MAX_TEXTS
                && (chunk.length === 0 || chars + uncached[i].length <= MAX_CHARS)
            ) {
                chars += uncached[i].length;
                chunk.push(uncached[i]);
                i++;
            }
            const translated = await translateTextsFree(chunk, 'en', 'de');
            chunk.forEach((src, k) => {
                const de = translated[k];
                // CRITICAL: only cache a REAL translation. If it equals the source
                // the translate call fell back to English (failure/rate-limit) —
                // do NOT cache it, so the next poll retries instead of pinning the
                // hotel to English forever.
                if (de && de.trim() && de !== src) ESSENTIAL_INFO_DE_CACHE.set(src, de);
            });
        }
        for (const [code, en] of map) {
            map.set(code, ESSENTIAL_INFO_DE_CACHE.get(en) ?? en);
        }
    }

    /**
     * Upserts an option detail into the cache.
     */
    async upsertOptionDetail(data: {
        tid: string;
        hotelCode?: string;
        data: any;
        nonRefundable?: boolean;
        cxlOptionDate?: Date | null;
        cxlConditions?: any;
        cxlComment?: string;
        cxlRemarks?: any;
        daypricesTotal?: number;
        daypricesCurrency?: string;
        mealType?: string;
        mealName?: string;
        providerPrice?: number;
        providerCurrency?: string;
        supplierCode?: string;
        essentialInfo?: string;
        priceComment?: string;
        supplements?: any;
        optionalExtras?: any;
        specialOffers?: any;
        rooms?: any;
        success?: boolean;
        versionDescription?: string;
        expiresAt?: Date;
    }) {
        const payload: any = {
            tid: data.tid,
            data: data.data,
            fetchedAt: new Date(),
        };

        if (data.hotelCode !== undefined) payload.hotelCode = data.hotelCode;
        if (data.nonRefundable !== undefined) payload.nonRefundable = data.nonRefundable;
        if (data.cxlOptionDate !== undefined) payload.cxlOptionDate = data.cxlOptionDate;
        if (data.cxlConditions !== undefined) payload.cxlConditions = data.cxlConditions;
        if (data.cxlComment !== undefined) payload.cxlComment = data.cxlComment;
        if (data.cxlRemarks !== undefined) payload.cxlRemarks = data.cxlRemarks;
        if (data.daypricesTotal !== undefined) payload.daypricesTotal = new Decimal(data.daypricesTotal).toFixed(2);
        if (data.daypricesCurrency !== undefined) payload.daypricesCurrency = data.daypricesCurrency;
        if (data.mealType !== undefined) payload.mealType = data.mealType;
        if (data.mealName !== undefined) payload.mealName = data.mealName;
        if (data.providerPrice !== undefined) payload.providerPrice = new Decimal(data.providerPrice).toFixed(2);
        if (data.providerCurrency !== undefined) payload.providerCurrency = data.providerCurrency;
        if (data.supplierCode !== undefined) payload.supplierCode = data.supplierCode;
        if (data.essentialInfo !== undefined) payload.essentialInfo = data.essentialInfo;
        if (data.priceComment !== undefined) payload.priceComment = data.priceComment;
        if (data.supplements !== undefined) payload.supplements = data.supplements;
        if (data.optionalExtras !== undefined) payload.optionalExtras = data.optionalExtras;
        if (data.specialOffers !== undefined) payload.specialOffers = data.specialOffers;
        if (data.rooms !== undefined) payload.rooms = data.rooms;
        if (data.success !== undefined) payload.success = data.success;
        if (data.versionDescription !== undefined) payload.versionDescription = data.versionDescription;
        if (data.expiresAt !== undefined) payload.expiresAt = data.expiresAt;

        return prisma.hotelOptionDetail.upsert({
            where: { tid: data.tid },
            update: payload,
            create: payload,
        });
    }
}

export default new HotelSearchRepository();
