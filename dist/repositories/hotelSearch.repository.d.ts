import Decimal from 'decimal.js';
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
export declare class HotelSearchRepository {
    /**
     * Returns hotel codes for a given destination, filtered by star ratings.
     * Used to build the HotelIds list for the WBE search call.
     */
    getHotelCodesByDestination(destinationId: number, starRatings: number[], limit?: number): Promise<HotelCodeRow[]>;
    /**
     * Returns a map of hotelCode → hotel info for enriching search results.
     * Includes the primary image key (displayOrder=0) from HotelImage if available.
     */
    getHotelsByCode(hotelCodes: string[]): Promise<Map<string, HotelCodeRow>>;
    /**
     * Returns a map of hotelCode → facility list (id + name) for the given hotel codes.
     * Used to enrich hotel probe results with amenity data.
     */
    getFacilitiesByHotelCodes(hotelCodes: string[]): Promise<Map<string, Array<{
        id: number;
        name: string;
    }>>>;
    /**
     * Returns all master facilities (for filter sidebar).
     */
    getAllFacilities(): Promise<Array<{
        id: number;
        name: string;
    }>>;
    /**
     * Returns facilities available for hotels in a given destination.
     * Useful for showing only relevant filter options.
     */
    getFacilitiesByDestination(destinationId: number): Promise<Array<{
        id: number;
        name: string;
        hotelCount: number;
    }>>;
    /**
     * Returns hotel codes from the given list that have ALL of the specified facility IDs.
     * Used for amenity filtering in hotel search.
     */
    filterHotelCodesByFacilities(hotelCodes: string[], facilityIds: number[]): Promise<string[]>;
    /**
     * Returns a cached option detail by TID, or null if not found / expired.
     */
    getCachedOptionDetail(tid: string): Promise<{
        id: string;
        createdAt: Date;
        data: import("@prisma/client/runtime/library").JsonValue;
        success: boolean | null;
        rooms: import("@prisma/client/runtime/library").JsonValue | null;
        hotelCode: string | null;
        supplierCode: string | null;
        tid: string;
        fetchedAt: Date;
        expiresAt: Date | null;
        nonRefundable: boolean | null;
        cxlOptionDate: Date | null;
        cxlConditions: import("@prisma/client/runtime/library").JsonValue | null;
        cxlComment: string | null;
        cxlRemarks: import("@prisma/client/runtime/library").JsonValue | null;
        daypricesTotal: import("@prisma/client/runtime/library").Decimal | null;
        daypricesCurrency: string | null;
        mealType: string | null;
        mealName: string | null;
        providerPrice: import("@prisma/client/runtime/library").Decimal | null;
        providerCurrency: string | null;
        essentialInfo: string | null;
        priceComment: string | null;
        supplements: import("@prisma/client/runtime/library").JsonValue | null;
        optionalExtras: import("@prisma/client/runtime/library").JsonValue | null;
        specialOffers: import("@prisma/client/runtime/library").JsonValue | null;
        versionDescription: string | null;
    } | null>;
    /**
     * Upserts an option detail into the cache.
     */
    upsertOptionDetail(data: {
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
    }): Promise<{
        id: string;
        createdAt: Date;
        data: import("@prisma/client/runtime/library").JsonValue;
        success: boolean | null;
        rooms: import("@prisma/client/runtime/library").JsonValue | null;
        hotelCode: string | null;
        supplierCode: string | null;
        tid: string;
        fetchedAt: Date;
        expiresAt: Date | null;
        nonRefundable: boolean | null;
        cxlOptionDate: Date | null;
        cxlConditions: import("@prisma/client/runtime/library").JsonValue | null;
        cxlComment: string | null;
        cxlRemarks: import("@prisma/client/runtime/library").JsonValue | null;
        daypricesTotal: import("@prisma/client/runtime/library").Decimal | null;
        daypricesCurrency: string | null;
        mealType: string | null;
        mealName: string | null;
        providerPrice: import("@prisma/client/runtime/library").Decimal | null;
        providerCurrency: string | null;
        essentialInfo: string | null;
        priceComment: string | null;
        supplements: import("@prisma/client/runtime/library").JsonValue | null;
        optionalExtras: import("@prisma/client/runtime/library").JsonValue | null;
        specialOffers: import("@prisma/client/runtime/library").JsonValue | null;
        versionDescription: string | null;
    }>;
}
declare const _default: HotelSearchRepository;
export default _default;
