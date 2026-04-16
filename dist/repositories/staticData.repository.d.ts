export declare class StaticDataRepository {
    upsertDestination(data: any): Promise<{
        name: string;
        id: number;
        createdAt: Date;
        metadata: import("@prisma/client/runtime/library").JsonValue | null;
        lastSyncedAt: Date | null;
        countryCode: string | null;
        region: string | null;
        parentId: number | null;
    }>;
    upsertHotel(data: any): Promise<{
        name: string;
        createdAt: Date;
        metadata: import("@prisma/client/runtime/library").JsonValue | null;
        destinationId: number | null;
        starRating: import("@prisma/client/runtime/library").Decimal | null;
        hotelCode: string;
        masterHotelId: number | null;
        hotelDetailsUrl: string | null;
        totalRooms: number | null;
        category: string | null;
        giataCode: string | null;
        address: string | null;
        addressCity: string | null;
        addressCountry: string | null;
        latitude: import("@prisma/client/runtime/library").Decimal | null;
        longitude: import("@prisma/client/runtime/library").Decimal | null;
        propertyType: number | null;
        supplierCode: string | null;
        lastSyncedAt: Date | null;
        detailsFetchedAt: Date | null;
        giataSyncedAt: Date | null;
        giataStatus: string | null;
    }>;
    getAllHotelCodes(): Promise<Set<string>>;
    createManyHotels(data: any[]): Promise<import(".prisma/client").Prisma.BatchPayload>;
    updateHotel(hotelCode: string, data: any): Promise<{
        name: string;
        createdAt: Date;
        metadata: import("@prisma/client/runtime/library").JsonValue | null;
        destinationId: number | null;
        starRating: import("@prisma/client/runtime/library").Decimal | null;
        hotelCode: string;
        masterHotelId: number | null;
        hotelDetailsUrl: string | null;
        totalRooms: number | null;
        category: string | null;
        giataCode: string | null;
        address: string | null;
        addressCity: string | null;
        addressCountry: string | null;
        latitude: import("@prisma/client/runtime/library").Decimal | null;
        longitude: import("@prisma/client/runtime/library").Decimal | null;
        propertyType: number | null;
        supplierCode: string | null;
        lastSyncedAt: Date | null;
        detailsFetchedAt: Date | null;
        giataSyncedAt: Date | null;
        giataStatus: string | null;
    }>;
    upsertFacility(data: any): Promise<{
        name: string;
        id: number;
        createdAt: Date;
    }>;
    clearHotelFacilities(hotelCode: string): Promise<import(".prisma/client").Prisma.BatchPayload>;
    createHotelFacility(data: any): Promise<{
        id: string;
        createdAt: Date;
        hotelCode: string;
        facilityId: number;
    }>;
    upsertHotelImage(data: any): Promise<{
        id: string;
        createdAt: Date;
        hotelCode: string;
        imageKey: string;
        displayOrder: number;
        caption: string | null;
    }>;
    getHotelsNeedingDetails(): Promise<{
        hotelCode: string;
        hotelDetailsUrl: string | null;
    }[]>;
    clearHotelFacilityGroups(hotelCode: string, groupType?: string): Promise<import(".prisma/client").Prisma.BatchPayload>;
    createHotelFacilityGroups(groups: Array<{
        hotelCode: string;
        groupType: string;
        category?: string | null;
        facilities?: any;
    }>): Promise<import(".prisma/client").Prisma.BatchPayload>;
    upsertLanguage(data: {
        code: string;
        name?: string | null;
    }): Promise<{
        name: string | null;
        createdAt: Date;
        code: string;
    }>;
    upsertCurrency(data: {
        code: string;
        name?: string | null;
    }): Promise<{
        name: string | null;
        createdAt: Date;
        code: string;
    }>;
    upsertNationality(data: {
        code: string;
        name?: string | null;
    }): Promise<{
        name: string | null;
        createdAt: Date;
        code: string;
    }>;
    createJob(data: {
        type: string;
        status: any;
        totalRecords?: number;
    }): Promise<any>;
    updateJob(id: string, data: any): Promise<any>;
    getInProgressJob(type: string): Promise<any>;
    getLatestJob(type: string): Promise<any>;
}
declare const _default: StaticDataRepository;
export default _default;
