export declare class HotelRepository {
    findByCode(hotelCode: string): Promise<{
        name: string;
        metadata: import("@prisma/client/runtime/library").JsonValue;
        starRating: import("@prisma/client/runtime/library").Decimal | null;
        hotelCode: string;
        hotelDetailsUrl: string | null;
        totalRooms: number | null;
        category: string | null;
        address: string | null;
        addressCity: string | null;
        addressCountry: string | null;
        latitude: import("@prisma/client/runtime/library").Decimal | null;
        longitude: import("@prisma/client/runtime/library").Decimal | null;
        propertyType: number | null;
        detailsFetchedAt: Date | null;
    } | null>;
    search(options: {
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
}
declare const _default: HotelRepository;
export default _default;
