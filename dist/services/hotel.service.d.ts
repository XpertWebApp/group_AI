export declare class HotelService {
    searchHotels(query: {
        q?: string;
        destinationId?: number;
        starRating?: number;
        limit?: number;
        offset?: number;
    }): Promise<{
        name: string;
        destinationId: number | null;
        starRating: import("@prisma/client/runtime/library").Decimal | null;
        hotelCode: string;
        category: string | null;
        addressCity: string | null;
        addressCountry: string | null;
        supplierCode: string | null;
    }[]>;
    /**
     * Get full hotel details by hotel code.
     * Returns structured data from the metadata JSON (synced from WBE CDN).
     * If metadata is not yet synced and hotelDetailsUrl is available, fetches on-demand.
     */
    getHotelDetails(hotelCode: string): Promise<{
        hotelCode: string;
        name: string;
        description: any;
        location: any;
        address: string | null;
        addressCity: string | null;
        addressCountry: string | null;
        starRating: number | null;
        latitude: number | null;
        longitude: number | null;
        totalRooms: number | null;
        propertyType: number | null;
        category: string | null;
        email: any;
        phone: any;
        images: string[];
        roomFacilities: any;
        hotelFacilities: any;
    }>;
}
declare const _default: HotelService;
export default _default;
