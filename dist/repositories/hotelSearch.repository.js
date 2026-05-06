"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotelSearchRepository = void 0;
const client_1 = require("@prisma/client");
const decimal_js_1 = __importDefault(require("decimal.js"));
const imagePriority_1 = require("../config/imagePriority");
const sethubUrl_1 = require("../config/sethubUrl");
const prisma = new client_1.PrismaClient();
class HotelSearchRepository {
    /**
     * Returns hotel codes for a given destination, filtered by star ratings.
     * Used to build the HotelIds list for the WBE search call.
     */
    async getHotelCodesByDestination(destinationId, starRatings, limit = 200) {
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
        if (starRatings.length === 0) {
            return prisma.hotel.findMany({ where: { destinationId }, select, take: limit });
        }
        return prisma.hotel.findMany({
            where: {
                destinationId,
                OR: starRatings.flatMap((star) => [
                    { starRating: { gte: new decimal_js_1.default(star - 0.49), lte: new decimal_js_1.default(star + 0.49) } },
                ]),
            },
            select,
            take: limit,
        });
    }
    // ─── Destination hierarchy helpers — for "never say no" fallback ────────
    /**
     * Returns the chain of ancestor destinationIds (parent → grandparent → … → root).
     * Used by the search-relaxation pipeline to widen from exact area → parent → country.
     * Caps depth at 6 to avoid runaway loops on malformed data.
     */
    async getDestinationAncestry(destinationId) {
        const out = [];
        let cur = destinationId;
        for (let depth = 0; depth < 6; depth++) {
            const row = await prisma.destination.findUnique({
                where: { id: cur },
                select: { parentId: true },
            });
            if (!row?.parentId || out.includes(row.parentId))
                break;
            out.push(row.parentId);
            cur = row.parentId;
        }
        return out;
    }
    /**
     * Returns the country-level destinationId (top of the ancestry chain).
     * If the destination has no parent, returns null (it might already be the country).
     */
    async getCountryDestinationId(destinationId) {
        const ancestry = await this.getDestinationAncestry(destinationId);
        if (ancestry.length === 0)
            return null;
        return ancestry[ancestry.length - 1] ?? null;
    }
    /**
     * Look up a destination's display name. Used to build banner messages
     * when the search falls back to a wider destination.
     */
    async getDestinationName(destinationId) {
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
    async getNearbyDestinations(destinationId, maxResults = 5) {
        const dest = await prisma.destination.findUnique({
            where: { id: destinationId },
            select: { countryCode: true },
        });
        if (!dest?.countryCode)
            return [];
        const center = await prisma.hotel.aggregate({
            where: { destinationId, latitude: { not: null }, longitude: { not: null } },
            _avg: { latitude: true, longitude: true },
        });
        const lat = center._avg.latitude ? Number(center._avg.latitude) : null;
        const lng = center._avg.longitude ? Number(center._avg.longitude) : null;
        if (lat == null || lng == null)
            return [];
        const rows = await prisma.$queryRaw `
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
    async getHotelsByCode(hotelCodes) {
        if (hotelCodes.length === 0)
            return new Map();
        const [hotels, images, giataImages] = await Promise.all([
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
            prisma.hotelImage.findMany({
                where: {
                    hotelCode: { in: hotelCodes },
                    displayOrder: 0,
                },
                select: { hotelCode: true, imageKey: true },
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
        ]);
        const imageMap = new Map();
        for (const img of images)
            imageMap.set(img.hotelCode, img.imageKey);
        // Group GIATA images by hotelCode so we can pick the best one per hotel.
        const giataByHotel = new Map();
        for (const img of giataImages) {
            const arr = giataByHotel.get(img.hotelCode) ?? [];
            arr.push(img);
            giataByHotel.set(img.hotelCode, arr);
        }
        const map = new Map();
        for (const h of hotels) {
            // Extract short description from metadata JSON (Location is a brief summary, Description is often empty/long)
            const meta = h.metadata;
            const description = meta?.Location || meta?.Description || null;
            // Pick the best GIATA image per Oliver's priority (exterior → room → lobby → ...).
            // GIATA URLs need HTTP Basic Auth, so we wrap them in our proxy endpoint
            // (GET /api/v1/hotels/giata-image?url=<encoded>) which authenticates and streams.
            const bestGiata = (0, imagePriority_1.pickBestGiataImage)(giataByHotel.get(h.hotelCode) ?? []);
            // Prefer the largest available size: 4K (urlOriginal) → Full HD → large → medium → small.
            // Older rows not yet re-synced will fall back to urlLarge (800px) seamlessly.
            const rawGiataUrl = bestGiata
                ? (bestGiata.urlOriginal ?? bestGiata.urlFullHd ?? bestGiata.urlLarge ?? bestGiata.urlMedium ?? bestGiata.urlSmall ?? null)
                : null;
            const giataImageUrl = rawGiataUrl
                ? `/api/v1/hotels/giata-image?url=${encodeURIComponent(rawGiataUrl)}`
                : null;
            const { metadata: _meta, ...hotelFields } = h;
            map.set(h.hotelCode, {
                ...hotelFields,
                primaryImageKey: imageMap.get(h.hotelCode) ?? null,
                giataImageUrl,
                sethubDetailsUrl: (0, sethubUrl_1.buildSethubDetailsUrl)(h.masterHotelId),
                description,
            });
        }
        return map;
    }
    /**
     * Returns a map of hotelCode → facility list (id + name) for the given hotel codes.
     * Used to enrich hotel probe results with amenity data.
     */
    async getFacilitiesByHotelCodes(hotelCodes) {
        if (hotelCodes.length === 0)
            return new Map();
        const rows = await prisma.hotelFacility.findMany({
            where: { hotelCode: { in: hotelCodes } },
            select: { hotelCode: true, facilityId: true },
        });
        // Collect unique facility IDs
        const facilityIds = [...new Set(rows.map((r) => r.facilityId))];
        if (facilityIds.length === 0)
            return new Map();
        const facilities = await prisma.facility.findMany({
            where: { id: { in: facilityIds } },
            select: { id: true, name: true },
        });
        const facilityMap = new Map();
        for (const f of facilities)
            facilityMap.set(f.id, f.name);
        const result = new Map();
        for (const row of rows) {
            const name = facilityMap.get(row.facilityId);
            if (!name)
                continue;
            if (!result.has(row.hotelCode))
                result.set(row.hotelCode, []);
            result.get(row.hotelCode).push({ id: row.facilityId, name });
        }
        return result;
    }
    /**
     * Returns all master facilities (for filter sidebar).
     */
    async getAllFacilities() {
        return prisma.facility.findMany({
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
        });
    }
    /**
     * Returns facilities available for hotels in a given destination.
     * Useful for showing only relevant filter options.
     */
    async getFacilitiesByDestination(destinationId) {
        // Get hotel codes for this destination
        const hotels = await prisma.hotel.findMany({
            where: { destinationId },
            select: { hotelCode: true },
        });
        const hotelCodes = hotels.map((h) => h.hotelCode);
        if (hotelCodes.length === 0)
            return [];
        // Get facility IDs linked to these hotels with counts
        const hotelFacilities = await prisma.hotelFacility.findMany({
            where: { hotelCode: { in: hotelCodes } },
            select: { facilityId: true, hotelCode: true },
        });
        // Count hotels per facility
        const facilityHotelMap = new Map();
        for (const hf of hotelFacilities) {
            if (!facilityHotelMap.has(hf.facilityId))
                facilityHotelMap.set(hf.facilityId, new Set());
            facilityHotelMap.get(hf.facilityId).add(hf.hotelCode);
        }
        const facilityIds = [...facilityHotelMap.keys()];
        if (facilityIds.length === 0)
            return [];
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
    async filterHotelCodesByFacilities(hotelCodes, facilityIds) {
        if (hotelCodes.length === 0 || facilityIds.length === 0)
            return hotelCodes;
        const rows = await prisma.hotelFacility.findMany({
            where: {
                hotelCode: { in: hotelCodes },
                facilityId: { in: facilityIds },
            },
            select: { hotelCode: true, facilityId: true },
        });
        // Group by hotel code and check each has ALL requested facilities
        const hotelFacilityMap = new Map();
        for (const r of rows) {
            if (!hotelFacilityMap.has(r.hotelCode))
                hotelFacilityMap.set(r.hotelCode, new Set());
            hotelFacilityMap.get(r.hotelCode).add(r.facilityId);
        }
        return hotelCodes.filter((code) => {
            const facilities = hotelFacilityMap.get(code);
            if (!facilities)
                return false;
            return facilityIds.every((id) => facilities.has(id));
        });
    }
    /**
     * Returns a cached option detail by TID, or null if not found / expired.
     */
    async getCachedOptionDetail(tid) {
        return prisma.hotelOptionDetail.findUnique({
            where: { tid },
        });
    }
    /**
     * Upserts an option detail into the cache.
     */
    async upsertOptionDetail(data) {
        const payload = {
            tid: data.tid,
            data: data.data,
            fetchedAt: new Date(),
        };
        if (data.hotelCode !== undefined)
            payload.hotelCode = data.hotelCode;
        if (data.nonRefundable !== undefined)
            payload.nonRefundable = data.nonRefundable;
        if (data.cxlOptionDate !== undefined)
            payload.cxlOptionDate = data.cxlOptionDate;
        if (data.cxlConditions !== undefined)
            payload.cxlConditions = data.cxlConditions;
        if (data.cxlComment !== undefined)
            payload.cxlComment = data.cxlComment;
        if (data.cxlRemarks !== undefined)
            payload.cxlRemarks = data.cxlRemarks;
        if (data.daypricesTotal !== undefined)
            payload.daypricesTotal = new decimal_js_1.default(data.daypricesTotal).toFixed(2);
        if (data.daypricesCurrency !== undefined)
            payload.daypricesCurrency = data.daypricesCurrency;
        if (data.mealType !== undefined)
            payload.mealType = data.mealType;
        if (data.mealName !== undefined)
            payload.mealName = data.mealName;
        if (data.providerPrice !== undefined)
            payload.providerPrice = new decimal_js_1.default(data.providerPrice).toFixed(2);
        if (data.providerCurrency !== undefined)
            payload.providerCurrency = data.providerCurrency;
        if (data.supplierCode !== undefined)
            payload.supplierCode = data.supplierCode;
        if (data.essentialInfo !== undefined)
            payload.essentialInfo = data.essentialInfo;
        if (data.priceComment !== undefined)
            payload.priceComment = data.priceComment;
        if (data.supplements !== undefined)
            payload.supplements = data.supplements;
        if (data.optionalExtras !== undefined)
            payload.optionalExtras = data.optionalExtras;
        if (data.specialOffers !== undefined)
            payload.specialOffers = data.specialOffers;
        if (data.rooms !== undefined)
            payload.rooms = data.rooms;
        if (data.success !== undefined)
            payload.success = data.success;
        if (data.versionDescription !== undefined)
            payload.versionDescription = data.versionDescription;
        if (data.expiresAt !== undefined)
            payload.expiresAt = data.expiresAt;
        return prisma.hotelOptionDetail.upsert({
            where: { tid: data.tid },
            update: payload,
            create: payload,
        });
    }
}
exports.HotelSearchRepository = HotelSearchRepository;
exports.default = new HotelSearchRepository();
