export interface SupplierLimit {
    code: string;
    name: string;
    maxRooms: number | null;
    groupsAllowed: boolean;
    notes?: string;
}
/**
 * Loads supplier limits from DB into the in-memory cache.
 * Call this on server startup and after any supplier limit update.
 */
export declare function refreshSupplierLimitsCache(): Promise<void>;
/** Returns the active supplier limits map (DB cache or static fallback). */
export declare const SUPPLIER_LIMITS: Record<string, SupplierLimit>;
/** Returns the max rooms for a supplier. Unknown suppliers default to 9 (conservative). */
export declare function getSupplierMaxRooms(supplierCode: string): number;
/**
 * Returns the effective capped_max for a supplier for the A2 supplier split.
 *
 * Oliver's rule (EC5 + Step 3.1 / 3.3 from PDF):
 *   HPG (HyperGuest) is unlimited but MUST be capped at 40% of total rooms needed.
 *   This forces spread across channels for partial cancellation flexibility.
 *   All other suppliers use their fixed SUPPLIER_MAX_ROOMS limit.
 *
 * @param supplierCode    - WBE supplier code
 * @param totalRoomsNeeded - Total rooms needed for this group booking
 */
export declare function getCappedMax(supplierCode: string, totalRoomsNeeded: number): number;
/** Returns true if the supplier supports group bookings. */
export declare function isGroupAllowed(supplierCode: string): boolean;
