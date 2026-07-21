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

/**
 * Priority tier for supplier selection during hotel search allocation.
 * Higher tiers are allocated first; within the same tier, cheapest-first
 * is the tie-breaker.
 *
 * Mapping to Oliver's own words:
 *   HIGH   = "push"     — HyperGuest, Roibos
 *   MEDIUM = "preferred" — Expedia (PKG + SA), Sun Hotels, DOTW
 *   LOW    = "careful"   — HotelBeds, GoGlobal, RoomsXML, ABR, TBO
 *   AVOID  = "avoid"     — TALE, Mideast, POW (last-resort)
 *
 * AVOID is different from `groupsAllowed = false`: AVOID suppliers are
 * still eligible when no higher-priority supplier can fulfil the room.
 * `groupsAllowed = false` blocks the supplier entirely.
 */
export type SupplierPriority = 'HIGH' | 'MEDIUM' | 'LOW' | 'AVOID';

/**
 * Numeric rank used for sort comparisons — LOWER number = higher priority.
 * Order matches the allocation preference: HIGH picked first, AVOID last.
 */
export const SUPPLIER_PRIORITY_RANK: Record<SupplierPriority, number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
    AVOID: 3,
};

export interface SupplierLimit {
    code: string;
    name: string;
    maxRooms: number | null; // null = unlimited
    groupsAllowed: boolean;
    /**
     * Allocation priority tier. Defaults to MEDIUM for unknown / new
     * suppliers. See SupplierPriority above for the mapping to Oliver's
     * "push / preferred / careful / avoid" language.
     */
    priority: SupplierPriority;
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
    'AIC (XTG)': { code: 'AIC (XTG)', name: 'AIC Travel Group', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    BMMX: { code: 'BMMX', name: 'BookMe Maldives (XTG)', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    DDT: { code: 'DDT', name: 'Dida Travel', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    DOTW: { code: 'DOTW', name: 'DOTW', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    // Expedia: WBE lists PKG Rates + SA Rates; both use supplier code EANRP.
    EANRP: { code: 'EANRP', name: 'Expedia Group', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    GG: { code: 'GG', name: 'GoGlobal', maxRooms: 9, groupsAllowed: true, priority: 'LOW' },
    'GTS (XTG)': { code: 'GTS (XTG)', name: 'GTS (XTG)', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    HBA: { code: 'HBA', name: 'HotelBeds ApiTude', maxRooms: 6, groupsAllowed: true, priority: 'LOW', notes: 'Problems above 6 rooms' },
    HTS: { code: 'HTS', name: 'Hotelston', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    'HTS 1': { code: 'HTS 1', name: 'Hotelston 1', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    HPC: { code: 'HPC', name: 'HP Coral', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    HPG: { code: 'HPG', name: 'HyperGuest', maxRooms: null, groupsAllowed: true, priority: 'HIGH', notes: 'No limit' },
    ILSX: { code: 'ILSX', name: 'Illusions (XTG)', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    ILS3X: { code: 'ILS3X', name: 'Illusions X3 (XTG)', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    MK7: { code: 'MK7', name: 'Miki V7', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    NBDX: { code: 'NBDX', name: 'Nordbeds', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    POW_S: { code: 'POW_S', name: 'POW_S', maxRooms: 0, groupsAllowed: false, priority: 'AVOID', notes: 'Not for groups' },
    RS: { code: 'RS', name: 'Restel', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    RBSX: { code: 'RBSX', name: 'Roibos (XTG)', maxRooms: 9, groupsAllowed: true, priority: 'HIGH' },
    RMXML: { code: 'RMXML', name: 'RoomsXML', maxRooms: 7, groupsAllowed: true, priority: 'LOW', notes: 'Many problems' },
    SETT: { code: 'SETT', name: 'SETT Extranet', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM', notes: 'Internal' },
    SMYX: { code: 'SMYX', name: 'Smyrooms (XTC)', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    SNH: { code: 'SNH', name: 'Sun Hotels', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
    TBX_S: { code: 'TBX_S', name: 'Mideast Travel', maxRooms: 9, groupsAllowed: true, priority: 'AVOID' },
    TLE_S: { code: 'TLE_S', name: 'TALE TRAVEL', maxRooms: 0, groupsAllowed: false, priority: 'AVOID', notes: 'Not for groups' },
    YLG: { code: 'YLG', name: 'Yalago', maxRooms: 9, groupsAllowed: true, priority: 'MEDIUM' },
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
            // Effective priority when multiple rows share the same code
            // (e.g. Expedia PKG + SA both under EANRP): pick the BEST
            // (lowest SUPPLIER_PRIORITY_RANK number) so the more-preferred
            // configuration wins. If admin sets PKG=HIGH and SA=MEDIUM,
            // the resolved priority is HIGH — matches admin's most-recent
            // intent for that code.
            const bestPriority = group.reduce<SupplierPriority>((best, r) => {
                const rp = (r.priority as SupplierPriority) ?? 'MEDIUM';
                return SUPPLIER_PRIORITY_RANK[rp] < SUPPLIER_PRIORITY_RANK[best] ? rp : best;
            }, 'AVOID');
            const first = group[0]!;
            map[code] = {
                code,
                name: first.providerName,
                maxRooms: minMax === Infinity ? null : minMax,
                groupsAllowed,
                priority: bestPriority,
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

// ── Unknown-supplier tracking (2026-07-15 strict-mode change) ─────────────
// Track supplier codes we've already logged an "unknown" warning for so we
// don't spam the log with the same code thousands of times per search.
// Bounded set (max 200 entries) so a malicious or buggy WBE response can't
// leak memory. When the cap is hit, we clear and start over.
const _warnedUnknownSuppliers = new Set<string>();
function _warnUnknownSupplierOnce(context: string, code: string): void {
    if (_warnedUnknownSuppliers.size > 200) _warnedUnknownSuppliers.clear();
    const key = `${context}:${code}`;
    if (_warnedUnknownSuppliers.has(key)) return;
    _warnedUnknownSuppliers.add(key);
    // Plain console.warn — this file has zero external deps by design so it
    // can be imported from the queue worker without pulling logger into the
    // dep graph. The message is precise enough that grep-in-logs works.
    console.warn(
        `[supplierLimits] Unknown supplier code returned by WBE — dropped from results. ` +
        `context=${context} code=${JSON.stringify(code)} ` +
        `Add it to app.supplier_limits (and update SUPPLIER_LIMITS_FALLBACK) to include this supplier in future searches.`,
    );
}

/**
 * Returns the max rooms for a supplier.
 *
 * Behaviour change (2026-07-15, per client request):
 *   Unknown supplier codes now return 0 (dropped) instead of the old
 *   conservative default of 9. If WBE returns a supplier we haven't
 *   configured, we treat it as "not on the allowlist" and never allocate
 *   rooms from it. A warning is logged so we notice quickly and can add
 *   the missing supplier to the settings.
 *
 * If a supplier appears frequently in the log, add it to
 * `app.supplier_limits` (and the fallback map at the top of this file).
 */
export function getSupplierMaxRooms(supplierCode: string): number {
    const code = supplierCode?.toUpperCase?.() ?? '';
    const limit = SUPPLIER_LIMITS[code];
    if (!limit) {
        _warnUnknownSupplierOnce('getSupplierMaxRooms', code);
        return 0;
    }
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
 * Behaviour change (2026-07-15, per client request):
 *   Unknown supplier codes now return 0 (dropped) instead of the old
 *   conservative default of 9. Same reasoning as getSupplierMaxRooms.
 *
 * @param supplierCode    - WBE supplier code
 * @param totalRoomsNeeded - Total rooms needed for this group booking
 */
export function getCappedMax(supplierCode: string, totalRoomsNeeded: number): number {
    const code = supplierCode?.toUpperCase?.() ?? '';
    const limit = SUPPLIER_LIMITS[code];
    if (!limit) {
        _warnUnknownSupplierOnce('getCappedMax', code);
        return 0;
    }
    if (!limit.groupsAllowed) return 0;
    if (limit.maxRooms === null) {
        // HPG: no physical limit, but Oliver caps it at 40% of group size
        return Math.floor(totalRoomsNeeded * 0.40);
    }
    return limit.maxRooms;
}

/**
 * Returns true if the supplier supports group bookings.
 *
 * Behaviour change (2026-07-15, per client request):
 *   Unknown supplier codes now return `false` (excluded) instead of the
 *   old permissive default of `true`. This is the primary gate used by
 *   the probe worker to drop supplier options before they reach the
 *   allocation stage — see `hotelProbe.worker.ts` line ~163
 *   (`if (!isGroupAllowed(supplierCode)) continue;`). With this change,
 *   any supplier not on the configured allowlist is silently dropped
 *   from results, exactly as the client asked for.
 *
 * A warning is logged the first time we see each unknown code, so we
 * notice quickly and can add missing suppliers to the settings.
 */
export function isGroupAllowed(supplierCode: string): boolean {
    const code = supplierCode?.toUpperCase?.() ?? '';
    const limit = SUPPLIER_LIMITS[code];
    if (!limit) {
        _warnUnknownSupplierOnce('isGroupAllowed', code);
        return false;
    }
    return limit.groupsAllowed;
}

/**
 * Returns the allocation priority tier for a supplier.
 *
 *   HIGH   = "push"     — allocated first
 *   MEDIUM = "preferred" — allocated after HIGH
 *   LOW    = "careful"   — allocated after MEDIUM
 *   AVOID  = "avoid"     — last resort; only if no higher-priority option
 *
 * Unknown / not-configured supplier codes → 'AVOID' (safe default). This
 * matches the strict-mode gate philosophy: prefer to under-allocate an
 * unknown supplier than over-allocate one we know nothing about.
 * Combined with `isGroupAllowed` (which returns false for unknown codes
 * and drops them entirely at line 163 of hotelProbe.worker.ts), this
 * accessor is mostly defence-in-depth — unknown codes shouldn't reach
 * it in practice. But when they do, AVOID prevents them from jumping
 * ahead of properly-configured suppliers.
 */
export function getSupplierPriority(supplierCode: string): SupplierPriority {
    const code = supplierCode?.toUpperCase?.() ?? '';
    const limit = SUPPLIER_LIMITS[code];
    if (!limit) return 'AVOID';
    return limit.priority ?? 'MEDIUM';
}

/**
 * Returns true if this supplier's rates can be shown to customers.
 *
 * Behaviour change (2026-07-15, per client request):
 *   Unknown supplier codes now return `false` (excluded from customer-
 *   facing views) instead of the old permissive default of `true`. Any
 *   supplier that reaches this function unknown will already have been
 *   dropped by `isGroupAllowed` upstream, but we mirror the strict rule
 *   here for defence-in-depth.
 */
export function isCustomerFacing(supplierCode: string): boolean {
    const code = supplierCode?.toUpperCase?.() ?? '';
    const limit = SUPPLIER_LIMITS[code];
    if (!limit) {
        _warnUnknownSupplierOnce('isCustomerFacing', code);
        return false;
    }
    return limit.customerFacing !== false;
}
