/**
 * Supplier code → room limits and group booking rules.
 * Source: SETT Phase 1 guide (Oliver's meetings & emails).
 *
 * maxRooms: null = unlimited (HPG/HyperGuest)
 * groupsAllowed: false = skip entirely for group bookings
 */

export interface SupplierLimit {
    code: string;
    name: string;
    maxRooms: number | null; // null = unlimited
    groupsAllowed: boolean;
    notes?: string;
}

export const SUPPLIER_LIMITS: Record<string, SupplierLimit> = {
    BMMX: { code: 'BMMX', name: 'BookMe Maldives', maxRooms: 9, groupsAllowed: true },
    DDT: { code: 'DDT', name: 'Dida Travel', maxRooms: 9, groupsAllowed: true },
    DOTW: { code: 'DOTW', name: 'DOTW', maxRooms: 9, groupsAllowed: true },
    GG: { code: 'GG', name: 'GoGlobal', maxRooms: 9, groupsAllowed: true },
    HBA: { code: 'HBA', name: 'HotelBeds', maxRooms: 6, groupsAllowed: true, notes: 'Problems above 6 rooms' },
    HTS: { code: 'HTS', name: 'Hotelston', maxRooms: 9, groupsAllowed: true },
    HPC: { code: 'HPC', name: 'HP Coral', maxRooms: 9, groupsAllowed: true },
    HPG: { code: 'HPG', name: 'HyperGuest', maxRooms: null, groupsAllowed: true, notes: 'No limit' },
    WRW_ILSX: { code: 'WRW_ILSX', name: 'Illusions (XTG-WRW)', maxRooms: 9, groupsAllowed: true },
    ILSX: { code: 'ILSX', name: 'Illusions (XTG)', maxRooms: 9, groupsAllowed: true },
    MK7: { code: 'MK7', name: 'Miki V7', maxRooms: 9, groupsAllowed: true },
    POW_S: { code: 'POW_S', name: 'POW_S', maxRooms: 0, groupsAllowed: false, notes: 'Not for groups' },
    RS: { code: 'RS', name: 'Restel', maxRooms: 9, groupsAllowed: true },
    RMXML: { code: 'RMXML', name: 'RoomsXML', maxRooms: 7, groupsAllowed: true, notes: 'Many problems' },
    SETT: { code: 'SETT', name: 'Extranet', maxRooms: 9, groupsAllowed: true, notes: 'Internal' },
    SNH: { code: 'SNH', name: 'Sun Hotels', maxRooms: 9, groupsAllowed: true },
    TLE_S: { code: 'TLE_S', name: 'TLE_S', maxRooms: 0, groupsAllowed: false, notes: 'Not for groups' },
    YLG: { code: 'YLG', name: 'Yalago', maxRooms: 9, groupsAllowed: true },
};

/** Returns the max rooms for a supplier. Unknown suppliers default to 9 (conservative). */
export function getSupplierMaxRooms(supplierCode: string): number {
    const limit = SUPPLIER_LIMITS[supplierCode?.toUpperCase?.() ?? ''];
    if (!limit) return 9;
    if (limit.maxRooms === null) return Infinity;
    return limit.maxRooms;
}

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
export function getCappedMax(supplierCode: string, totalRoomsNeeded: number): number {
    const code = supplierCode?.toUpperCase?.() ?? '';
    const limit = SUPPLIER_LIMITS[code];
    if (!limit) return 9; // unknown — conservative default
    if (!limit.groupsAllowed) return 0;
    if (limit.maxRooms === null) {
        // HPG: no physical limit, but Oliver caps it at 40% of group size
        return Math.floor(totalRoomsNeeded * 0.40);
    }
    return limit.maxRooms;
}

/** Returns true if the supplier supports group bookings. */
export function isGroupAllowed(supplierCode: string): boolean {
    const limit = SUPPLIER_LIMITS[supplierCode?.toUpperCase?.() ?? ''];
    if (!limit) return true; // default: assume allowed
    return limit.groupsAllowed;
}
