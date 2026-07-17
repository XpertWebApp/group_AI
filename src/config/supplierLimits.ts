/**
 * Supplier code → room limits and group booking rules.
 *
 * DB-backed with in-memory cache. The static SUPPLIER_LIMITS_FALLBACK serves
 * as a safety net if the DB hasn't been loaded yet (e.g., during startup).
 *
 * maxRooms: 0 with unlimited flag = unlimited (HPG/HyperGuest)
 * groupsAllowed: false = skip entirely for group bookings
 */
import { PrismaClient } from '@prisma/client';

export interface SupplierLimit {
    code: string;
    name: string;
    maxRooms: number | null; // null = unlimited
    groupsAllowed: boolean;
    /**
     * If false, this supplier's rates are wholesale/net-only and must NOT be shown to customers.
     * Defaults to true (customer-facing) when omitted.
     */
    customerFacing?: boolean;
    notes?: string;
}

// ── Static fallback (used before DB cache is loaded) ────────────────────────
// Kept in sync with the official WBE Supplier list (see migration
// 20260717000000_update_supplier_limits_wbe_list). The DB table
// `app.supplier_limits` is the source of truth at runtime; this map is only the
// startup/failover fallback.
const SUPPLIER_LIMITS_FALLBACK: Record<string, SupplierLimit> = {
    'AIC (XTG)': { code: 'AIC (XTG)', name: 'AIC Travel Group', maxRooms: 9, groupsAllowed: true },
    BMMX: { code: 'BMMX', name: 'BookMe Maldives (XTG)', maxRooms: 9, groupsAllowed: true },
    DDT: { code: 'DDT', name: 'Dida Travel', maxRooms: 9, groupsAllowed: true },
    DOTW: { code: 'DOTW', name: 'DOTW', maxRooms: 9, groupsAllowed: true },
    // Expedia: WBE lists PKG Rates + SA Rates; both use supplier code EANRP.
    EANRP: { code: 'EANRP', name: 'Expedia Group', maxRooms: 9, groupsAllowed: true },
    GG: { code: 'GG', name: 'GoGlobal', maxRooms: 9, groupsAllowed: true },
    'GTS (XTG)': { code: 'GTS (XTG)', name: 'GTS (XTG)', maxRooms: 9, groupsAllowed: true },
    HBA: { code: 'HBA', name: 'HotelBeds ApiTude', maxRooms: 6, groupsAllowed: true, notes: 'Problems above 6 rooms' },
    HTS: { code: 'HTS', name: 'Hotelston', maxRooms: 9, groupsAllowed: true },
    'HTS 1': { code: 'HTS 1', name: 'Hotelston 1', maxRooms: 9, groupsAllowed: true },
    HPC: { code: 'HPC', name: 'HP Coral', maxRooms: 9, groupsAllowed: true },
    HPG: { code: 'HPG', name: 'HyperGuest', maxRooms: null, groupsAllowed: true, notes: 'No limit' },
    ILSX: { code: 'ILSX', name: 'Illusions (XTG)', maxRooms: 9, groupsAllowed: true },
    ILS3X: { code: 'ILS3X', name: 'Illusions X3 (XTG)', maxRooms: 9, groupsAllowed: true },
    MK7: { code: 'MK7', name: 'Miki V7', maxRooms: 9, groupsAllowed: true },
    NBDX: { code: 'NBDX', name: 'Nordbeds', maxRooms: 9, groupsAllowed: true },
    POW_S: { code: 'POW_S', name: 'POW_S', maxRooms: 0, groupsAllowed: false, notes: 'Not for groups' },
    RS: { code: 'RS', name: 'Restel', maxRooms: 9, groupsAllowed: true },
    RBSX: { code: 'RBSX', name: 'Roibos (XTG)', maxRooms: 9, groupsAllowed: true },
    RMXML: { code: 'RMXML', name: 'RoomsXML', maxRooms: 7, groupsAllowed: true, notes: 'Many problems' },
    SETT: { code: 'SETT', name: 'SETT Extranet', maxRooms: 9, groupsAllowed: true, notes: 'Internal' },
    SMYX: { code: 'SMYX', name: 'Smyrooms (XTC)', maxRooms: 9, groupsAllowed: true },
    SNH: { code: 'SNH', name: 'Sun Hotels', maxRooms: 9, groupsAllowed: true },
    TBX_S: { code: 'TBX_S', name: 'Mideast Travel', maxRooms: 9, groupsAllowed: true },
    TLE_S: { code: 'TLE_S', name: 'TALE TRAVEL', maxRooms: 0, groupsAllowed: false, notes: 'Not for groups' },
    YLG: { code: 'YLG', name: 'Yalago', maxRooms: 9, groupsAllowed: true },
};

// ── In-memory cache ─────────────────────────────────────────────────────────
let cachedLimits: Record<string, SupplierLimit> | null = null;

/**
 * Loads supplier limits from DB into the in-memory cache.
 * Call this on server startup and after any supplier limit update.
 */
export async function refreshSupplierLimitsCache(): Promise<void> {
    try {
        const prisma = new PrismaClient();
        const rows = await prisma.supplierLimit.findMany();
        await prisma.$disconnect();

        // Supplier codes are no longer unique (e.g. Expedia PKG + SA both use
        // EANRP). Group rows by code and collapse each group to ONE effective
        // limit — the MOST RESTRICTIVE: min rooms, and groups allowed only if
        // every row for that code allows groups.
        const grouped: Record<string, typeof rows> = {};
        for (const row of rows) {
            (grouped[row.supplierCode] ??= []).push(row);
        }

        const map: Record<string, SupplierLimit> = {};
        for (const [code, group] of Object.entries(grouped)) {
            const groupsAllowed = group.every((r) => r.groupsAllowed);
            // Per-row effective max: 0 rooms + groups allowed = unlimited (HPG).
            const effectiveMax = group.map((r) =>
                r.maxRooms === 0 && r.groupsAllowed ? Infinity : r.maxRooms,
            );
            const minMax = Math.min(...effectiveMax);
            const first = group[0]!;
            map[code] = {
                code,
                name: first.providerName,
                maxRooms: minMax === Infinity ? null : minMax,
                groupsAllowed,
                notes: first.notes ?? undefined,
            };
        }
        cachedLimits = map;
    } catch {
        // If DB is unavailable, keep using the fallback
        cachedLimits = null;
    }
}

/** Returns the active supplier limits map (DB cache or static fallback). */
export const SUPPLIER_LIMITS: Record<string, SupplierLimit> = new Proxy(
    {} as Record<string, SupplierLimit>,
    {
        get(_target, prop: string) {
            const source = cachedLimits ?? SUPPLIER_LIMITS_FALLBACK;
            return source[prop];
        },
        has(_target, prop: string) {
            const source = cachedLimits ?? SUPPLIER_LIMITS_FALLBACK;
            return prop in source;
        },
        ownKeys() {
            const source = cachedLimits ?? SUPPLIER_LIMITS_FALLBACK;
            return Object.keys(source);
        },
        getOwnPropertyDescriptor(_target, prop: string) {
            const source = cachedLimits ?? SUPPLIER_LIMITS_FALLBACK;
            if (prop in source) {
                return { configurable: true, enumerable: true, value: source[prop] };
            }
            return undefined;
        },
    },
);

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

/**
 * Returns true if this supplier's rates can be shown to customers.
 * Defaults to true unless explicitly set false (wholesale-only suppliers).
 */
export function isCustomerFacing(supplierCode: string): boolean {
    const limit = SUPPLIER_LIMITS[supplierCode?.toUpperCase?.() ?? ''];
    if (!limit) return true; // default: assume customer-facing
    return limit.customerFacing !== false;
}
