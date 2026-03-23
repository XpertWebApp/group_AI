

import { randomUUID } from 'crypto';
import requestRepository from '../repositories/request.repository';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import wbeClientService from './wbe.client.service';
import { publishHotelProbeJob } from '../queue/hotelProbe.publisher';
import logger from '../utils/logger';
import { getSupplierMaxRooms, isGroupAllowed, getCappedMax } from '../config/supplierLimits';
import { PROBE_BATCH_SIZE, PROBE_MULTIPLIER, PROBE_WAIT_SECONDS, ROOM_TYPE_ADULTS } from '../config/probeConfig';
import type { ExpandedRoom, RoomTypeProbeTarget } from '../queue/hotelProbeJob.types';
import { countTotalRooms } from '../utils/roomUtils';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Always search with this many rooms per Oliver's rule (never the actual group count). */
const SEARCH_ROOMS = 3;

/** Number of adults per searched room. */
const ADULTS_PER_ROOM = 2;

/** Max hotel codes per WBE search call. */
const MAX_HOTEL_IDS_PER_CALL = 100;

/** Poll interval when WBE returns Finished: false (ms). */
const POLL_INTERVAL_MS = 3000;

/** Max total wait time for session-level polling (ms). */
const MAX_POLL_WAIT_MS = 60_000;

/** Option detail cache TTL in hours. */
const OPTION_DETAIL_TTL_HOURS = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HotelSearchParams {
    /** Filter by meal type. 'BB' = breakfast, 'RO' = room only. Omit to accept all. */
    mealType?: string;
    /** If true, also search hotels at starRating ±1. Default: true. */
    includeAlternativeStars?: boolean;
    /** WBE API wait seconds. Default: 35. */
    waitSeconds?: number;
    /** Currency override. Falls back to request currency. */
    currencyCode?: string;
    /** Nationality override. Falls back to request nationalityCode. */
    nationalityCode?: string;
}

export interface ProcessedOption {
    tid: string;
    supplierCode: string;
    /** Price per room per night, normalised from WBE response (TotalPrice ÷ SEARCH_ROOMS ÷ nights). */
    pricePerRoomPerNight: number;
    /** Raw total price returned by WBE for the searched configuration. */
    rawTotalPrice: number;
    currency: string;
    freeCancellation: boolean;
    /** false = instant confirm; true = on-request (slower). Groups should prefer false. */
    onRequest: boolean;
    mealType: string;
    mealName: string;
    /** Room description(s) from WBE Rooms array. */
    roomDescriptions: string[];
    cancelDeadline?: string | null;
    /** Max rooms this supplier can provide for a group booking. */
    maxRoomsFromSupplier: number;
    /** Provider (hotel's native) price before markup. */
    providerPrice?: number;
    providerCurrency?: string;
    /** Whether WBE flagged this option as needing a GetUpdatedOptions refresh. */
    updatedOptionsNeeded: boolean;
}

export interface SupplierSplit {
    supplierCode: string;
    tid: string;
    rooms: number;
    pricePerRoomPerNight: number;
    currency: string;
}

/**
 * A flat summary of the best (cheapest mid-range) option for a hotel.
 * Exposed on each HotelResult for easy frontend consumption.
 */
export interface HotelBestOption {
    tid: string;
    sessionId: string;
    supplierCode: string;
    buyingPricePerRoomPerNight: number;
    currency: string;
    freeCancellation: boolean;
    cancelDeadline: string | null;
    mealType: string;
    mealName: string;
    roomDescriptions: string[];
}

export interface HotelResult {
    hotelCode: string;
    hotelName: string;
    starRating?: number | null;
    imageUrl?: string | null;
    address?: string | null;
    addressCity?: string | null;
    addressCountry?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    sessionId: string;
    /**
     * include  – hotel can confidently fulfill the requested room count
     * flag     – risky (inventory overlap likely), include as secondary option
     * omit     – cannot fulfill the group size
     */
    status: 'include' | 'flag' | 'omit';
    /** Physical room count from WBE static DB. Used for overlap check. */
    totalRooms?: number | null;
    /** Effective rooms this hotel can contribute after overlap check (Steps 3.1–3.2). */
    roomsAllocated?: number;
    /** True when hotel.total_rooms is unknown — offer should be flagged (EC4). */
    inventoryOverlapFlag?: boolean;
    /** Sum of maxRooms across all usable, group-allowed suppliers for this hotel. */
    totalAvailableRooms: number;
    /** The highest mid-range price per room per night (used as buying price base). */
    highestMidRangePrice?: number;
    currency?: string;
    /**
     * Flat summary of the best option — what the frontend needs to show a result card
     * and to call option-details. Uses the cheapest mid-range option.
     */
    bestOption?: HotelBestOption;
    /** All options that passed free-cxl + meal-type + group-allowed + not-on-request filter. */
    usableOptions: ProcessedOption[];
    /** Options selected in the mid-range band (excluding bottom/top 20%). */
    selectedOptions: ProcessedOption[];
    /** Internal supplier split plan (NEVER expose to customer). */
    supplierSplit: SupplierSplit[];
    /** Human-readable note for operators. */
    note?: string;
}

export interface HotelSearchResponse {
    requestId: string;
    sessionId: string;
    finished: boolean;
    totalRoomsRequested: number;
    results: HotelResult[];
    /** Hotels at alternative star ratings (±1 from requested). */
    alternativeResults: HotelResult[];
    /** Summary stats for the agent UI. */
    summary: {
        total: number;
        included: number;
        flagged: number;
        omitted: number;
    };
}

/**
 * Returned by searchForRequest and generateAutoOffer after the new queue-based flow.
 * The actual hotel results arrive asynchronously via SSE / polling.
 */
export interface HotelSearchQueueResponse {
    requestId: string;
    totalCandidates: number;
    jobsQueued: number;
    message: string;
    /** Subscribe for real-time hotel-level updates. */
    sseEndpoint: string;
    /** Poll this endpoint if SSE is not available. */
    statusEndpoint: string;
}

// ─── Auto-Offer Types (accumulation loop — PDF Steps 2–4) ────────────────────

/** One accepted hotel in the auto-generated offer. */
export interface AutoOfferHotel {
    hotelCode: string;
    hotelName: string;
    starRating: number | null;
    imageUrl: string | null;
    address: string | null;
    addressCity: string | null;
    addressCountry: string | null;
    roomsAllocated: number;
    /** Earliest cancellation deadline across all A2 supplier entries. */
    cxlDeadline: string | null;
    /** True when hotel.total_rooms is unknown — offer should note unverified inventory. */
    inventoryOverlapFlag: boolean;
    note?: string;
    /** Internal supplier split — NEVER expose to customer (Oliver's Rule 3). */
    supplierSplit: SupplierSplit[];
}

/** Result of the full accumulation loop (Steps 2–4 from the PDF). */
export interface AutoOfferResult {
    success: boolean;
    requestId: string;
    roomsNeeded: number;
    roomsCommitted: number;
    currency: string;
    nights: number;
    validatedHotels: AutoOfferHotel[];
    // ── Pricing (Step 4.1) — only set when success = true ───────────────────
    /** Highest mid-band supplier price across ALL A2 splits (buying price base). */
    buyingPriceBase?: number;
    /** Unified sell price per room per night shown to the customer. */
    sellingPricePerRoomPerNight?: number;
    /** Total offer price = sellingPrice × roomsNeeded × nights. */
    totalOfferPrice?: number;
    markupPercent?: number;
    // ── Escalation (only set when success = false) ───────────────────────────
    escalation?: {
        roomsMissing: number;
        partialHotels: AutoOfferHotel[];
        suggestion: string;
    };
}

export interface CancellationCondition {
    fromDate: string;
    toDate: string;
    amount: number;
    currency: string;
    text: string;
}

export interface CancellationPolicy {
    nonRefundable: boolean;
    deadline: string | null;
    conditions: CancellationCondition[];
    comment: string | null;
}

export interface RoomDayPrice {
    date: string;
    price: number;
}

export interface OptionDetailsResponse {
    tid: string;
    hotelCode: string;
    cached: boolean;
    /** Raw API response (full, for debugging). */
    data: any;
    /** Structured, parsed fields ready for frontend use. */
    parsed: {
        nonRefundable?: boolean;
        cxlDeadline?: string | null;
        mealType?: string;
        mealName?: string;
        daypricesTotal?: number;
        daypricesCurrency?: string;
        providerPrice?: number;
        essentialInfo?: string;
        /** Per-room, per-night price breakdown. */
        roomBreakdown?: Array<{
            roomId: number;
            description: string;
            prices: RoomDayPrice[];
        }>;
        /** Clean cancellation policy object. */
        cancellationPolicy?: CancellationPolicy;
        supplements?: any[];
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Expand the booking request rooms JSON into a flat ordered list of individual rooms.
 * e.g. { double: 3, single: 1 } → [2-adult, 2-adult, 2-adult, 1-adult]
 * Used by buildProbeBatch to compose the Rooms array for each probe call.
 */
export function expandRequestRooms(rooms: any): ExpandedRoom[] {
    if (!rooms || typeof rooms !== 'object') return [{ adults: ADULTS_PER_ROOM, children: 0, childrenAges: [] }];
    const expanded: ExpandedRoom[] = [];
    for (const [type, count] of Object.entries(rooms)) {
        const n = Number(count) || 0;
        const adults = ROOM_TYPE_ADULTS[type as string] ?? ADULTS_PER_ROOM;
        for (let i = 0; i < n; i++) {
            expanded.push({ adults, children: 0, childrenAges: [] });
        }
    }
    return expanded.length > 0 ? expanded : [{ adults: ADULTS_PER_ROOM, children: 0, childrenAges: [] }];
}

/**
 * Build per-room-type probe targets from the booking request rooms JSON.
 * Each room type gets its own target with probeLimit = requested × PROBE_MULTIPLIER.
 * e.g. { single: 5, double: 10 } → [
 *   { roomType: 'single', requested: 5, probeLimit: 10, adults: 1, ... },
 *   { roomType: 'double', requested: 10, probeLimit: 20, adults: 2, ... },
 * ]
 */
export function buildRoomTypeTargets(rooms: any): RoomTypeProbeTarget[] {
    if (!rooms || typeof rooms !== 'object') return [];
    const targets: RoomTypeProbeTarget[] = [];
    for (const [type, count] of Object.entries(rooms)) {
        const n = Number(count) || 0;
        if (n <= 0) continue;
        const adults = ROOM_TYPE_ADULTS[type] ?? ADULTS_PER_ROOM;
        targets.push({
            roomType: type,
            requested: n,
            probeLimit: n * PROBE_MULTIPLIER,
            adults,
            children: 0,
            childrenAges: [],
        });
    }
    return targets;
}

/**
 * Build the WBE Rooms array for one probe batch.
 * startRoomId is 1-based (R1 = first room, R4 = second batch, etc.).
 * Room composition cycles through expandedRooms so the adults/children
 * match the actual group composition.
 */
export function buildProbeBatch(
    expandedRooms: ExpandedRoom[],
    startRoomId: number,
    batchSize: number = PROBE_BATCH_SIZE,
): Array<{ RoomID: number; AdultsNo: string; ChildrenNo: string; ChildrenAges: number[] }> {
    return Array.from({ length: batchSize }, (_, i) => {
        const roomIndex = (startRoomId - 1 + i) % expandedRooms.length;
        const room = expandedRooms[roomIndex];
        return {
            RoomID: startRoomId + i,
            AdultsNo: String(room.adults),
            ChildrenNo: String(room.children),
            ChildrenAges: room.childrenAges,
        };
    });
}

/** @deprecated Use buildProbeBatch with expandRequestRooms instead. Kept for backward-compat. */
function buildSearchRooms(): Array<{ RoomID: number; AdultsNo: string; ChildrenNo: string; ChildrenAges: any[] }> {
    return Array.from({ length: SEARCH_ROOMS }, (_, i) => ({
        RoomID: i + 1,
        AdultsNo: String(ADULTS_PER_ROOM),
        ChildrenNo: '0',
        ChildrenAges: [],
    }));
}

/** Safely read a field from an object that may use PascalCase or camelCase. */
function field<T>(obj: any, ...keys: string[]): T | undefined {
    for (const k of keys) {
        if (obj != null && obj[k] !== undefined) return obj[k] as T;
    }
    return undefined;
}

/**
 * Normalise the price from WBE option to a per-room-per-night value.
 * WBE returns a total for the searched configuration (SEARCH_ROOMS × nights).
 */
function normalisePricePerRoomPerNight(rawPrice: number, nights: number): number {
    if (!rawPrice || !nights) return 0;
    return rawPrice / (SEARCH_ROOMS * nights);
}

/**
 * Skip the bottom `trimPct`% and top `trimPct`% of prices.
 * Returns prices that fall in the mid-range band.
 */
function selectMidRange(prices: number[], trimPct = 20): number[] {
    if (prices.length === 0) return [];
    const sorted = [...prices].sort((a, b) => a - b);
    const cutLow = Math.floor((sorted.length * trimPct) / 100);
    const cutHigh = Math.ceil(sorted.length * (1 - trimPct / 100));
    return sorted.slice(cutLow, cutHigh);
}

/**
 * Determine hotel capacity status.
 *
 * Rules from the SETT Phase 1 guide:
 * - If any unlimited supplier (HPG) is available → include
 * - If totalAvailableRooms >= requestedRooms → include
 * - If totalAvailableRooms >= requestedRooms × 0.7 → flag as risky
 * - Otherwise → omit
 */
function determineStatus(
    totalAvailable: number,
    requested: number,
    hasUnlimited: boolean,
): { status: 'include' | 'flag' | 'omit'; note?: string } {
    if (hasUnlimited) {
        return { status: 'include', note: 'Unlimited supplier (HPG) available' };
    }
    if (totalAvailable >= requested) {
        return { status: 'include' };
    }
    if (totalAvailable >= Math.floor(requested * 0.7)) {
        return {
            status: 'flag',
            note: `Only ~${totalAvailable} rooms across suppliers (requested ${requested}). Inventory overlap possible.`,
        };
    }
    return {
        status: 'omit',
        note: `Insufficient capacity: ~${totalAvailable} rooms available, ${requested} requested.`,
    };
}

/**
 * Step 3.3 — Build the supplier split (A2 array).
 * Allocates rooms to suppliers cheapest-first up to each supplier's getCappedMax.
 * HPG is capped at 40% of totalRoomsNeeded (Oliver's rule EC5).
 *
 * @param midBandOptions    - Mid-band options after all filters (price band, dedup)
 * @param targetContribution - Rooms to fill for this hotel (from contribution check)
 * @param totalRoomsNeeded  - Total group rooms needed (for HPG 40% cap)
 */
function buildSupplierSplit(
    midBandOptions: ProcessedOption[],
    targetContribution: number,
    totalRoomsNeeded: number,
): SupplierSplit[] {
    const sorted = [...midBandOptions].sort((a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight);
    const split: SupplierSplit[] = [];
    let remaining = targetContribution;

    for (const opt of sorted) {
        if (remaining <= 0) break;
        const cap = getCappedMax(opt.supplierCode, totalRoomsNeeded);
        const allocate = Math.min(cap, remaining);
        if (allocate <= 0) continue;

        split.push({
            supplierCode: opt.supplierCode,
            tid: opt.tid,
            rooms: allocate,
            pricePerRoomPerNight: opt.pricePerRoomPerNight,
            currency: opt.currency,
        });
        remaining -= allocate;
    }

    return split;
}

/**
 * Step 2.3 — Determine the dominant (highest-count) room type from the request.
 * Returns null if no rooms specified or all counts are zero.
 */
function getDominantRoomType(rooms: any): string | null {
    if (!rooms || typeof rooms !== 'object') return null;
    const types = [
        { type: 'double',    count: rooms.double    ?? 0 },
        { type: 'single',    count: rooms.single    ?? 0 },
        { type: 'twin',      count: rooms.twin      ?? 0 },
        { type: 'triple',    count: rooms.triple    ?? 0 },
        { type: 'quadruple', count: rooms.quadruple ?? 0 },
        { type: 'suite',     count: rooms.suites    ?? 0 },
    ];
    const max = types.reduce((a, b) => (b.count > a.count ? b : a), { type: null as string | null, count: 0 });
    return max.count > 0 ? max.type : null;
}

/**
 * Step 2.3 — Room type matching with Oliver's flexibility rules.
 * Returns true if the option's room descriptions match the requested type.
 *
 * Oliver's flexibility (from PDF):
 *   Single  requested → accept Twin  (twin used for single occupancy)
 *   Double  requested → accept Twin  (same physical space)
 *   Triple  requested → accept Quad  (upgrade if triple unavailable)
 *
 * If requestedType is null or descriptions empty → always true (no filtering).
 */
function matchesRoomType(roomDescriptions: string[], requestedType: string | null): boolean {
    if (!requestedType) return true;
    if (roomDescriptions.length === 0) return true; // no description from WBE — include by default

    const descs = roomDescriptions.map((d) => d.toLowerCase());
    const type = requestedType.toLowerCase();

    const acceptable = [type];
    if (type === 'single')    acceptable.push('twin');
    if (type === 'double')    acceptable.push('twin');
    if (type === 'triple')    acceptable.push('quad');

    return descs.some((d) => acceptable.some((kw) => d.includes(kw)));
}

/**
 * Step 2.3 — Supplier deduplication.
 * If the same supplier code appears more than once, keep only the lowest-priced entry.
 * Prevents double-counting a single supplier's physical room inventory.
 */
function deduplicateBySupplier(options: ProcessedOption[]): ProcessedOption[] {
    const map = new Map<string, ProcessedOption>();
    for (const opt of options) {
        const existing = map.get(opt.supplierCode);
        if (!existing || opt.pricePerRoomPerNight < existing.pricePerRoomPerNight) {
            map.set(opt.supplierCode, opt);
        }
    }
    return Array.from(map.values());
}

/**
 * Steps 3.1 + 3.2 — Capacity check + Inventory Overlap Check.
 *
 * 3.1: Uses getCappedMax per supplier (HPG → 40% of group size).
 *      hotel_contribution = MIN(sum_capped_max, rooms_still_needed).
 *      Returns contribution = 0 if below minimum 6-room threshold.
 *
 * 3.2: If total_supplier_claim > hotel.total_rooms × 0.70 → overlap likely.
 *      Apply conservative safe cap: hotel.total_rooms × 0.60.
 *      If hotel.total_rooms unknown → flag it but proceed.
 */
function computeHotelContribution(
    midBandOptions: ProcessedOption[],
    hotelTotalRooms: number | null | undefined,
    totalRoomsNeeded: number,
    roomsStillNeeded: number,
): { contribution: number; inventoryOverlapFlag: boolean; overlapDetected: boolean; note?: string } {
    const totalSupplierClaim = midBandOptions.reduce(
        (sum, o) => sum + getCappedMax(o.supplierCode, totalRoomsNeeded),
        0,
    );

    let effectiveCapacity = totalSupplierClaim;
    let inventoryOverlapFlag = false;
    let overlapDetected = false;
    let note: string | undefined;

    if (hotelTotalRooms && hotelTotalRooms > 0) {
        if (totalSupplierClaim > hotelTotalRooms * 0.70) {
            // Multiple suppliers likely reselling same physical rooms
            effectiveCapacity = Math.floor(hotelTotalRooms * 0.60);
            overlapDetected = true;
            note = `Inventory overlap detected — capped at 60% of hotel physical capacity (${hotelTotalRooms} rooms).`;
        }
    } else {
        // total_rooms unknown (EC4) — proceed but flag for offer
        inventoryOverlapFlag = true;
        note = 'Room inventory unverified — confirm directly with hotel.';
    }

    const contribution = Math.min(effectiveCapacity, roomsStillNeeded);
    return { contribution, inventoryOverlapFlag, overlapDetected, note };
}

/**
 * Parse WBE options from the hotel entry in the search response.
 *
 * Live API field names confirmed from actual API call:
 *   TID, TotalPrice, Currency, UpdatedOptionsNeeded, MealType, MealName,
 *   FreeCancellation, ClxDeadline, OnRequest, SupplierCode,
 *   ProviderPrice, ProviderCurrency, Rooms[{ RoomId, Description }]
 */
function parseWbeOptions(wbeHotelOptions: any[], nights: number): ProcessedOption[] {
    const result: ProcessedOption[] = [];

    for (const opt of wbeHotelOptions ?? []) {
        const tid = field<string>(opt, 'TID', 'Tid', 'tid');
        const rawPrice = field<number>(opt, 'TotalPrice', 'totalPrice', 'Price', 'price');

        // tid and rawPrice are absolutely required to process an option
        if (!tid || rawPrice === undefined) continue;

        // SupplierCode confirmed present in live API response. Fall back to 'UNKNOWN'
        // so options are not silently dropped if a new supplier appears.
        const supplierCode = field<string>(opt, 'SupplierCode', 'supplierCode', 'Supplier', 'supplier') ?? 'UNKNOWN';
        const currency = field<string>(opt, 'Currency', 'currency', 'CurrencyCode') ?? 'EUR';
        const freeCancellation = field<boolean>(opt, 'FreeCancellation', 'freeCancellation') ?? false;
        const onRequest = field<boolean>(opt, 'OnRequest', 'onRequest') ?? false;
        const mealType = field<string>(opt, 'MealType', 'mealType', 'BoardType', 'boardType') ?? '';
        const mealName = field<string>(opt, 'MealName', 'mealName', 'BoardName', 'boardName') ?? '';
        const updatedOptionsNeeded = field<boolean>(opt, 'UpdatedOptionsNeeded', 'updatedOptionsNeeded') ?? false;

        // ClxDeadline confirmed from live response. Keep CxlDeadline as fallback for compatibility.
        const cancelDeadline = field<string>(
            opt,
            'ClxDeadline', 'clxDeadline',
            'CxlDeadline', 'cxlDeadline',
            'CancellationDeadline', 'cancellationDeadline',
        ) ?? null;

        const providerPrice = field<number>(opt, 'ProviderPrice', 'providerPrice');
        const providerCurrency = field<string>(opt, 'ProviderCurrency', 'providerCurrency');

        // Extract room descriptions from the Rooms array
        const rawRooms: any[] = field<any[]>(opt, 'Rooms', 'rooms') ?? [];
        const roomDescriptions = rawRooms
            .map((r) => field<string>(r, 'Description', 'description', 'RoomName', 'roomName') ?? '')
            .filter(Boolean);

        const pricePerRoomPerNight = normalisePricePerRoomPerNight(rawPrice, nights);
        const maxRoomsFromSupplier = getSupplierMaxRooms(supplierCode);

        result.push({
            tid,
            supplierCode,
            pricePerRoomPerNight,
            rawTotalPrice: rawPrice,
            currency,
            freeCancellation,
            onRequest,
            mealType,
            mealName,
            roomDescriptions,
            cancelDeadline,
            maxRoomsFromSupplier,
            providerPrice,
            providerCurrency,
            updatedOptionsNeeded,
        });
    }

    return result;
}

/**
 * Parse a WBE OptionDetailsV2 response.
 *
 * Actual response structure (confirmed from WBE docs):
 * {
 *   "Data": {
 *     "CxlPolicy": { "OptionDate", "NonRefundable", "Conditions": [...], "Comment" },
 *     "DayPrices":  { "TotalPrice", "Currency", "MealType", "MealName",
 *                     "EssentialInfo", "Rooms": [{ "RoomId", "Description", "Prices": [...] }],
 *                     "Supplements": [...] }
 *   }
 * }
 */
function parseOptionDetails(raw: any): {
    nonRefundable: boolean;
    cxlDeadline: string | null;
    mealType?: string;
    mealName?: string;
    daypricesTotal?: number;
    daypricesCurrency?: string;
    providerPrice?: number;
    essentialInfo?: string;
    roomBreakdown: Array<{ roomId: number; description: string; prices: RoomDayPrice[] }>;
    cancellationPolicy: CancellationPolicy;
    supplements?: any[];
    cxlConditions?: any;
    cxlComment?: string;
    supplierCode?: string;
} {
    const data = raw?.Data ?? raw?.data ?? raw ?? {};

    // CxlPolicy is a nested object under Data
    const cxlPolicy = data?.CxlPolicy ?? data?.cxlPolicy ?? data?.CancellationPolicy ?? {};
    // DayPrices is a nested object under Data
    const dayPricesObj = data?.DayPrices ?? data?.dayPrices ?? {};

    // ── Cancellation policy ──────────────────────────────────────────────────
    const nonRefundable: boolean =
        field<boolean>(cxlPolicy, 'NonRefundable', 'nonRefundable', 'IsNonRefundable') ?? false;

    // The cancellation deadline — OptionDate is the field confirmed in WBE docs
    const cxlDeadline: string | null =
        field<string>(cxlPolicy, 'OptionDate', 'optionDate', 'CancellationDeadline', 'cancellationDeadline') ??
        null;

    const rawConditions: any[] = field<any[]>(cxlPolicy, 'Conditions', 'conditions', 'CancellationConditions') ?? [];
    const conditions: CancellationCondition[] = rawConditions.map((c) => ({
        fromDate: field<string>(c, 'FromDate', 'fromDate', 'From') ?? '',
        toDate: field<string>(c, 'ToDate', 'toDate', 'To') ?? '',
        amount: field<number>(c, 'Amount', 'amount', 'Penalty') ?? 0,
        currency: field<string>(c, 'Currency', 'currency') ?? '',
        text: field<string>(c, 'Text', 'text', 'Description') ?? '',
    }));

    const cxlComment: string | undefined =
        field<string>(cxlPolicy, 'Comment', 'comment', 'Remarks', 'remarks') ?? undefined;

    const cancellationPolicy: CancellationPolicy = {
        nonRefundable,
        deadline: cxlDeadline,
        conditions,
        comment: cxlComment ?? null,
    };

    // ── Day prices / pricing ─────────────────────────────────────────────────
    const daypricesTotal: number | undefined =
        field<number>(dayPricesObj, 'TotalPrice', 'totalPrice', 'Total', 'total');

    const daypricesCurrency: string | undefined =
        field<string>(dayPricesObj, 'Currency', 'currency', 'CurrencyCode');

    const mealType: string | undefined =
        field<string>(dayPricesObj, 'MealType', 'mealType', 'BoardType');

    const mealName: string | undefined =
        field<string>(dayPricesObj, 'MealName', 'mealName', 'BoardName');

    const essentialInfo: string | undefined =
        field<string>(dayPricesObj, 'EssentialInfo', 'essentialInfo', 'EssentialInformation', 'ImportantInfo');

    const supplements: any[] | undefined =
        field<any[]>(dayPricesObj, 'Supplements', 'supplements');

    // Per-room, per-day price breakdown
    const rawRooms: any[] = field<any[]>(dayPricesObj, 'Rooms', 'rooms') ?? [];
    const roomBreakdown = rawRooms.map((r) => {
        const roomId = field<number>(r, 'RoomId', 'roomId', 'RoomID', 'roomID') ?? 0;
        const description = field<string>(r, 'Description', 'description', 'RoomName') ?? '';
        const rawPrices: any[] = field<any[]>(r, 'Prices', 'prices', 'DayPrices') ?? [];
        const prices: RoomDayPrice[] = rawPrices.map((p) => ({
            date: field<string>(p, 'Date', 'date') ?? '',
            price: field<number>(p, 'Price', 'price', 'Amount') ?? 0,
        }));
        return { roomId, description, prices };
    });

    // Provider price (may be at the Data level or inside DayPrices)
    const providerPrice: number | undefined =
        field<number>(data, 'ProviderPrice', 'providerPrice') ??
        field<number>(dayPricesObj, 'ProviderPrice', 'providerPrice');

    const supplierCode: string | undefined =
        field<string>(data, 'SupplierCode', 'supplierCode') ??
        field<string>(dayPricesObj, 'SupplierCode', 'supplierCode');

    return {
        nonRefundable,
        cxlDeadline,
        mealType,
        mealName,
        daypricesTotal,
        daypricesCurrency,
        providerPrice,
        essentialInfo,
        roomBreakdown,
        cancellationPolicy,
        supplements,
        cxlConditions: rawConditions.length > 0 ? rawConditions : undefined,
        cxlComment,
        supplierCode,
    };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class HotelSearchService {
    /**
     * Queue-based hotel search orchestration for a booking request.
     *
     * Dispatches one HotelProbeJob per candidate hotel to RabbitMQ.
     * Each job probes R1-R3, R4-R6, R7-R9 … sequentially until capacity is confirmed.
     * Returns immediately — results arrive via SSE (GET /requests/:id/hotel-search/events)
     * or polling (GET /requests/:id/hotel-search/status).
     */
    async searchForRequest(requestId: string, params: HotelSearchParams = {}): Promise<HotelSearchQueueResponse> {
        // 1. Load request
        const request = await requestRepository.findById(requestId);
        if (!request) {
            throw { status: 404, message: 'Booking request not found', code: 'NOT_FOUND' };
        }

        const totalRooms = countTotalRooms(request.rooms);
        if (totalRooms === 0) {
            throw { status: 400, message: 'Booking request has no rooms specified', code: 'INVALID_REQUEST' };
        }

        const nights = request.nights;
        const destinationId = request.destinationId;
        const requestedStarRating = (request as any).starRating ? Number((request as any).starRating) : null;
        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        const nationalityCode = params.nationalityCode ?? request.nationalityCode ?? 'HU';
        const includeAlternativeStars = params.includeAlternativeStars !== false;
        const waitSeconds = params.waitSeconds ?? PROBE_WAIT_SECONDS;
        const markupPercent = 18;

        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);

        const dominantRoomType = getDominantRoomType((request as any).rooms);
        const expandedRooms = expandRequestRooms((request as any).rooms);

        // Resolve candidate hotels from DB
        const primaryStars = requestedStarRating ? [requestedStarRating] : [];
        const altStars = includeAlternativeStars && requestedStarRating
            ? [requestedStarRating - 1, requestedStarRating + 1].filter((s) => s >= 1 && s <= 5)
            : [];
        const allSearchStars = [...new Set([...primaryStars, ...altStars])];

        const dbHotels = await hotelSearchRepository.getHotelCodesByDestination(
            destinationId,
            allSearchStars.length > 0 ? allSearchStars : [],
        );

        if (dbHotels.length === 0) {
            logger.warn({ requestId, destinationId, starRatings: allSearchStars }, 'No hotels found in DB for destination');
            return {
                requestId,
                totalCandidates: 0,
                jobsQueued: 0,
                message: 'No candidate hotels found for this destination and star rating.',
                sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
                statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
            };
        }

        // Dispatch one HotelProbeJob per hotel to RabbitMQ
        const roomTypeTargets = buildRoomTypeTargets((request as any).rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * PROBE_MULTIPLIER;
        let jobsQueued = 0;

        for (const dbHotel of dbHotels) {
            const jobId = randomUUID();
            await hotelProbeJobRepository.create({
                id: jobId,
                searchRequestId: requestId,
                hotelCode: dbHotel.hotelCode,
                requestedRooms: totalRooms,
                probeLimit,
            });
            await publishHotelProbeJob({
                jobId,
                searchRequestId: requestId,
                hotelCode: dbHotel.hotelCode,
                checkinDate,
                nights,
                requestedRooms: totalRooms,
                probeLimit,
                currencyCode,
                nationalityCode,
                waitSeconds,
                mealType: params.mealType,
                markupPercent,
                expandedRooms,
                dominantRoomType,
                roomTypeTargets,
            });
            jobsQueued++;
        }

        logger.info({ requestId, totalCandidates: dbHotels.length, jobsQueued }, 'Hotel probe jobs queued');

        return {
            requestId,
            totalCandidates: dbHotels.length,
            jobsQueued,
            message: `${jobsQueued} hotel probe jobs queued. Subscribe to SSE for real-time updates.`,
            sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
            statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
        };
    }

    /**
     * Polls GetUpdatedOptions until Finished: true or timeout.
     * Used for both session-level (Finished: false) and per-option (UpdatedOptionsNeeded: true) polling.
     * Returns the hotel entries from the poll response.
     */
    private async pollUntilFinished(sessionId: string): Promise<any[]> {
        const startTime = Date.now();
        const accumulated: any[] = [];

        while (Date.now() - startTime < MAX_POLL_WAIT_MS) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

            try {
                const update = await wbeClientService.getUpdatedOptionsV2({ SessionID: sessionId });
                // Key fix: poll response also uses 'Data' not 'Hotels'
                const hotels = field<any[]>(update, 'Data', 'data', 'Hotels', 'hotels') ?? [];
                accumulated.push(...hotels);

                const done = field<boolean>(update, 'Finished', 'finished') ?? false;
                if (done) break;
            } catch (err: any) {
                logger.warn({ sessionId, error: err.message }, 'Poll GetUpdatedOptions failed');
                break;
            }
        }

        return accumulated;
    }

    /**
     * Fetch option details for one or more TIDs and cache the results.
     *
     * Step 6 from the guide: "Get Detailed Pricing (OptionDetailsV2)"
     * Returns per-night price breakdown + cancellation policy.
     */
    async fetchOptionDetails(
        selections: Array<{ sessionId: string; tid: string; hotelCode: string }>,
    ): Promise<OptionDetailsResponse[]> {
        const results: OptionDetailsResponse[] = [];

        await Promise.all(
            selections.map(async ({ sessionId, tid, hotelCode }) => {
                // Check cache first
                const cached = await hotelSearchRepository.getCachedOptionDetail(tid);
                if (cached && (!cached.expiresAt || cached.expiresAt > new Date())) {
                    const cxlDeadline = cached.cxlOptionDate?.toISOString() ?? null;
                    const cachedConditions: any[] = (cached.cxlConditions as any[]) ?? [];

                    results.push({
                        tid,
                        hotelCode,
                        cached: true,
                        data: cached.data,
                        parsed: {
                            nonRefundable: cached.nonRefundable ?? undefined,
                            cxlDeadline,
                            mealType: cached.mealType ?? undefined,
                            daypricesTotal: cached.daypricesTotal ? Number(cached.daypricesTotal) : undefined,
                            daypricesCurrency: cached.daypricesCurrency ?? undefined,
                            providerPrice: cached.providerPrice ? Number(cached.providerPrice) : undefined,
                            essentialInfo: cached.essentialInfo ?? undefined,
                            roomBreakdown: (cached.rooms as any) ?? [],
                            cancellationPolicy: {
                                nonRefundable: cached.nonRefundable ?? false,
                                deadline: cxlDeadline,
                                conditions: cachedConditions.map((c: any) => ({
                                    fromDate: c.FromDate ?? c.fromDate ?? '',
                                    toDate: c.ToDate ?? c.toDate ?? '',
                                    amount: c.Amount ?? c.amount ?? 0,
                                    currency: c.Currency ?? c.currency ?? '',
                                    text: c.Text ?? c.text ?? '',
                                })),
                                comment: cached.cxlComment ?? null,
                            },
                        },
                    });
                    return;
                }

                try {
                    const raw = await wbeClientService.optionDetailsV2({
                        SessionID: sessionId,
                        TID: tid,
                        HotelCode: hotelCode,
                    });

                    const parsed = parseOptionDetails(raw);
                    const expiresAt = new Date(Date.now() + OPTION_DETAIL_TTL_HOURS * 60 * 60 * 1000);

                    await hotelSearchRepository.upsertOptionDetail({
                        tid,
                        hotelCode,
                        data: raw,
                        nonRefundable: parsed.nonRefundable,
                        cxlOptionDate: parsed.cxlDeadline ? new Date(parsed.cxlDeadline) : undefined,
                        cxlConditions: parsed.cxlConditions,
                        cxlComment: parsed.cxlComment,
                        daypricesTotal: parsed.daypricesTotal,
                        daypricesCurrency: parsed.daypricesCurrency,
                        mealType: parsed.mealType,
                        mealName: parsed.mealName,
                        providerPrice: parsed.providerPrice,
                        supplierCode: parsed.supplierCode,
                        essentialInfo: parsed.essentialInfo,
                        rooms: parsed.roomBreakdown,
                        supplements: parsed.supplements,
                        success: true,
                        expiresAt,
                    });

                    results.push({
                        tid,
                        hotelCode,
                        cached: false,
                        data: raw,
                        parsed: {
                            nonRefundable: parsed.nonRefundable,
                            cxlDeadline: parsed.cxlDeadline,
                            mealType: parsed.mealType,
                            mealName: parsed.mealName,
                            daypricesTotal: parsed.daypricesTotal,
                            daypricesCurrency: parsed.daypricesCurrency,
                            providerPrice: parsed.providerPrice,
                            essentialInfo: parsed.essentialInfo,
                            roomBreakdown: parsed.roomBreakdown,
                            cancellationPolicy: parsed.cancellationPolicy,
                            supplements: parsed.supplements,
                        },
                    });
                } catch (err: any) {
                    logger.error({ tid, hotelCode, error: err.message }, 'OptionDetailsV2 failed');
                    results.push({
                        tid,
                        hotelCode,
                        cached: false,
                        data: null,
                        parsed: {},
                    });
                }
            }),
        );

        return results;
    }

    /**
     * Webhook-triggered auto offer — queue-based version.
     *
     * Dispatches one HotelProbeJob per candidate hotel (primary stars first, then
     * alternatives). Each job runs R1-R3 → R4-R6 → … probes sequentially in the
     * worker and emits SSE events as results arrive. Returns immediately.
     *
     * Used by offerGeneration.service.ts for webhook-triggered auto offers.
     */
    async generateAutoOffer(
        requestId: string,
        params: HotelSearchParams & { markupPercent?: number } = {},
    ): Promise<HotelSearchQueueResponse> {
        const request = await requestRepository.findById(requestId);
        if (!request) {
            throw { status: 404, message: 'Booking request not found', code: 'NOT_FOUND' };
        }

        const totalRooms = countTotalRooms(request.rooms);
        if (totalRooms === 0) {
            throw { status: 400, message: 'Booking request has no rooms specified', code: 'INVALID_REQUEST' };
        }

        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        const nationalityCode = params.nationalityCode ?? request.nationalityCode ?? 'HU';
        const includeAlternativeStars = params.includeAlternativeStars !== false;
        const waitSeconds = params.waitSeconds ?? PROBE_WAIT_SECONDS;
        const markupPercent = params.markupPercent ?? 18;

        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);

        const dominantRoomType = getDominantRoomType((request as any).rooms);
        const expandedRooms = expandRequestRooms((request as any).rooms);

        const requestedStarRating = (request as any).starRating ? Number((request as any).starRating) : null;
        const primaryStars = requestedStarRating ? [requestedStarRating] : [];
        const altStars = includeAlternativeStars && requestedStarRating
            ? [requestedStarRating - 1, requestedStarRating + 1].filter((s) => s >= 1 && s <= 5)
            : [];
        const allSearchStars = [...new Set([...primaryStars, ...altStars])];

        const dbHotels = await hotelSearchRepository.getHotelCodesByDestination(
            request.destinationId,
            allSearchStars.length > 0 ? allSearchStars : [],
        );

        if (dbHotels.length === 0) {
            logger.warn({ requestId, destinationId: request.destinationId }, 'Auto-offer: no hotels in DB');
            return {
                requestId,
                totalCandidates: 0,
                jobsQueued: 0,
                message: 'No candidate hotels found for this destination and star rating.',
                sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
                statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
            };
        }

        // Primary stars first, then alternatives
        const primaryHotelCodes = new Set(
            primaryStars.length === 0
                ? dbHotels.map((h) => h.hotelCode)
                : dbHotels
                      .filter((h) => {
                          const s = h.starRating ? Number(h.starRating) : null;
                          return s !== null && primaryStars.some((ps) => Math.abs(ps - s) < 0.5);
                      })
                      .map((h) => h.hotelCode),
        );
        const sortedHotels = [
            ...dbHotels.filter((h) => primaryHotelCodes.has(h.hotelCode)),
            ...dbHotels.filter((h) => !primaryHotelCodes.has(h.hotelCode)),
        ];

        const roomTypeTargets = buildRoomTypeTargets((request as any).rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * PROBE_MULTIPLIER;
        let jobsQueued = 0;

        for (const dbHotel of sortedHotels) {
            const jobId = randomUUID();
            await hotelProbeJobRepository.create({
                id: jobId,
                searchRequestId: requestId,
                hotelCode: dbHotel.hotelCode,
                requestedRooms: totalRooms,
                probeLimit,
            });
            await publishHotelProbeJob({
                jobId,
                searchRequestId: requestId,
                hotelCode: dbHotel.hotelCode,
                checkinDate,
                nights: request.nights,
                requestedRooms: totalRooms,
                probeLimit,
                currencyCode,
                nationalityCode,
                waitSeconds,
                mealType: params.mealType,
                markupPercent,
                expandedRooms,
                dominantRoomType,
                roomTypeTargets,
            });
            jobsQueued++;
        }

        logger.info({ requestId, totalCandidates: dbHotels.length, jobsQueued }, 'Auto-offer probe jobs queued');

        return {
            requestId,
            totalCandidates: dbHotels.length,
            jobsQueued,
            message: `${jobsQueued} hotel probe jobs queued for auto-offer generation.`,
            sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
            statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
        };
    }

    /**
     * Calculate the recommended customer sell price for a hotel.
     *
     * Step 7 from the guide:
     *   1. Take the highest mid-range supplier buying price
     *   2. Apply markup (15-20%)
     *   3. Apply price psychology (avoid round numbers)
     */
    calculateSellPrice(
        buyingPrice: number,
        markupPercent: number = 18,
    ): { buyingPrice: number; sellPrice: number; markupPercent: number } {
        const raw = buyingPrice * (1 + markupPercent / 100);
        const rounded = Math.ceil(raw);
        let psychPrice = rounded;
        if (rounded % 10 === 0) psychPrice = rounded - 2; // €200 → €198
        else if (rounded % 5 === 0) psychPrice = rounded - 1; // €195 → €194

        return { buyingPrice, sellPrice: psychPrice, markupPercent };
    }
}

export default new HotelSearchService();
