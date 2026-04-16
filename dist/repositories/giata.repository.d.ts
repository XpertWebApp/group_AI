/**
 * GIATA Repository
 *
 * Database operations for GIATA hotel content:
 * - HotelGiataText (multilingual descriptions)
 * - HotelGiataFact (structured fact sheets)
 * - HotelGiataImage (image URLs)
 * - HotelGiataMapping (supplier code mappings)
 */
export declare class GiataRepository {
    upsertTexts(hotelCode: string, giataId: string, texts: Array<{
        lang: string;
        sectionType: string;
        title: string;
        content: string;
        lastUpdate?: string | null;
    }>): Promise<void>;
    getTexts(hotelCode: string, lang?: string): Promise<{
        id: string;
        title: string;
        hotelCode: string;
        lang: string;
        giataId: string;
        lastUpdate: Date | null;
        sectionType: string;
        content: string;
        syncedAt: Date;
    }[]>;
    upsertFacts(hotelCode: string, giataId: string, facts: Array<{
        sectionType: string;
        sectionName: string;
        factId: number;
        factName: string;
        typeHint: string;
        value: string;
        unit?: string;
        fee?: boolean;
    }>): Promise<void>;
    getFacts(hotelCode: string): Promise<{
        id: string;
        value: string;
        hotelCode: string;
        giataId: string;
        sectionType: string;
        syncedAt: Date;
        sectionName: string;
        factId: number;
        factName: string;
        typeHint: string;
        unit: string | null;
        fee: boolean | null;
    }[]>;
    upsertImages(hotelCode: string, giataId: string, images: Array<{
        imageType: string;
        displayOrder: number;
        urlSmall?: string;
        urlMedium?: string;
        urlLarge?: string;
        lastUpdate?: string | null;
    }>): Promise<void>;
    getImages(hotelCode: string): Promise<{
        id: string;
        hotelCode: string;
        displayOrder: number;
        giataId: string;
        lastUpdate: Date | null;
        syncedAt: Date;
        imageType: string;
        urlSmall: string | null;
        urlMedium: string | null;
        urlLarge: string | null;
    }[]>;
    upsertMappings(hotelCode: string, giataId: string, mappings: Array<{
        providerCode: string;
        providerType: string;
        codeValue: string;
    }>): Promise<void>;
    getMappings(hotelCode: string): Promise<{
        id: string;
        hotelCode: string;
        giataId: string;
        providerCode: string;
        syncedAt: Date;
        providerType: string;
        codeValue: string;
    }[]>;
    /** Get hotels that have a giataCode populated (candidates for GIATA sync). */
    getHotelsWithGiataCode(opts?: {
        limit?: number;
        offset?: number;
    }): Promise<{
        name: string;
        hotelCode: string;
        giataCode: string | null;
        supplierCode: string | null;
    }[]>;
    /** Get hotels without giataCode but with a supplierCode (for Multicodes resolution). */
    getHotelsWithoutGiataCode(opts?: {
        limit?: number;
    }): Promise<{
        name: string;
        hotelCode: string;
        supplierCode: string | null;
    }[]>;
    /** Count hotels by GIATA sync status. */
    getGiataStatusCounts(): Promise<Record<string, number>>;
    createSyncJob(type: string, totalRecords?: number): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.JobStatus;
        type: string;
        startedAt: Date;
        completedAt: Date | null;
        totalRecords: number | null;
        processedRecords: number;
        lastProcessedKey: string | null;
        errorMessage: string | null;
    }>;
    updateSyncJob(id: string, data: any): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.JobStatus;
        type: string;
        startedAt: Date;
        completedAt: Date | null;
        totalRecords: number | null;
        processedRecords: number;
        lastProcessedKey: string | null;
        errorMessage: string | null;
    }>;
    getInProgressJob(type: string): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.JobStatus;
        type: string;
        startedAt: Date;
        completedAt: Date | null;
        totalRecords: number | null;
        processedRecords: number;
        lastProcessedKey: string | null;
        errorMessage: string | null;
    } | null>;
    getLatestJob(type: string): Promise<{
        id: string;
        status: import(".prisma/client").$Enums.JobStatus;
        type: string;
        startedAt: Date;
        completedAt: Date | null;
        totalRecords: number | null;
        processedRecords: number;
        lastProcessedKey: string | null;
        errorMessage: string | null;
    } | null>;
    /** Count hotels with giataCode for total records tracking. */
    countHotelsWithGiataCode(): Promise<number>;
    /** Update GIATA sync status on a hotel. */
    updateGiataStatus(hotelCode: string, status: string, giataCode?: string): Promise<void>;
}
declare const _default: GiataRepository;
export default _default;
