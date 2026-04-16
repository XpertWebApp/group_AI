export interface SupplierLimitRow {
    id: string;
    supplierCode: string;
    providerName: string;
    accCode: string | null;
    maxRooms: number;
    groupsAllowed: boolean;
    notes: string | null;
    updatedAt: Date;
    createdAt: Date;
}
export declare class SupplierLimitsRepository {
    /**
     * List all supplier limits with optional search and pagination.
     */
    findAll(opts: {
        search?: string;
        page?: number;
        limit?: number;
    }): Promise<{
        data: SupplierLimitRow[];
        total: number;
        page: number;
        limit: number;
    }>;
    /**
     * Get a single supplier limit by supplier code.
     */
    findByCode(supplierCode: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        notes: string | null;
        supplierCode: string;
        providerName: string;
        accCode: string | null;
        maxRooms: number;
        groupsAllowed: boolean;
    } | null>;
    /**
     * Update a supplier limit's maxRooms (and optionally other fields).
     */
    update(supplierCode: string, data: {
        maxRooms?: number;
        groupsAllowed?: boolean;
        providerName?: string;
        accCode?: string;
        notes?: string;
    }): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        notes: string | null;
        supplierCode: string;
        providerName: string;
        accCode: string | null;
        maxRooms: number;
        groupsAllowed: boolean;
    }>;
    /**
     * Get all supplier limits as a map (for use in hotelSearch service).
     */
    getAllAsMap(): Promise<Record<string, {
        maxRooms: number;
        groupsAllowed: boolean;
        providerName: string;
    }>>;
    /**
     * Get last updated timestamp for the supplier limits section.
     */
    getLastUpdated(): Promise<Date | null>;
}
declare const _default: SupplierLimitsRepository;
export default _default;
