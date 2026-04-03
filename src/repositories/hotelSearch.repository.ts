import { PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';

const prisma = new PrismaClient();

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
    /** Primary image key (displayOrder=0) from HotelImage table, if available. */
    primaryImageKey?: string | null;
    /** Short description extracted from metadata.Location (or metadata.Description fallback). */
    description?: string | null;
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
    ): Promise<HotelCodeRow[]> {
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
                    { starRating: { gte: new Decimal(star - 0.49), lte: new Decimal(star + 0.49) } },
                ]),
            },
            select,
            take: limit,
        });
    }

    /**
     * Returns a map of hotelCode → hotel info for enriching search results.
     * Includes the primary image key (displayOrder=0) from HotelImage if available.
     */
    async getHotelsByCode(hotelCodes: string[]): Promise<Map<string, HotelCodeRow>> {
        if (hotelCodes.length === 0) return new Map();

        const [hotels, images] = await Promise.all([
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
        ]);

        const imageMap = new Map<string, string>();
        for (const img of images) imageMap.set(img.hotelCode, img.imageKey);

        const map = new Map<string, HotelCodeRow>();
        for (const h of hotels) {
            // Extract short description from metadata JSON (Location is a brief summary, Description is often empty/long)
            const meta = h.metadata as Record<string, any> | null;
            const description = meta?.Location || meta?.Description || null;

            const { metadata: _meta, ...hotelFields } = h;
            map.set(h.hotelCode, {
                ...hotelFields,
                primaryImageKey: imageMap.get(h.hotelCode) ?? null,
                description,
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
