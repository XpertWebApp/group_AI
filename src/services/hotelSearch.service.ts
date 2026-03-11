

import requestRepository from '../repositories/request.repository';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import wbeClientService from './wbe.client.service';
import logger from '../utils/logger';
import { getSupplierMaxRooms, isGroupAllowed, getCappedMax } from '../config/supplierLimits';

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

/** Count the total rooms requested across all room types. */
function countTotalRooms(rooms: any): number {
    if (!rooms || typeof rooms !== 'object') return 0;
    return (
        (rooms.single ?? 0) +
        (rooms.double ?? 0) +
        (rooms.twin ?? 0) +
        (rooms.triple ?? 0) +
        (rooms.quadruple ?? 0) +
        (rooms.suites ?? 0)
    );
}

/** Build the Rooms array for the WBE search body (always SEARCH_ROOMS entries). */
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
     * Full hotel search orchestration for a booking request.
     *
     * Steps:
     *  1. Load request from DB
     *  2. Get hotel codes by destination + star rating (±1 if includeAlternativeStars)
     *  3. Call WBE SearchAndGetByHotelsV2 with SEARCH_ROOMS rooms
     *  4. Session-level poll if Finished: false
     *  5. Per-option poll for any options with UpdatedOptionsNeeded: true (Option B)
     *  6. Filter, validate capacity, select mid-range, build supplier split
     */
    async searchForRequest(requestId: string, params: HotelSearchParams = {}): Promise<HotelSearchResponse> {
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
        const waitSeconds = params.waitSeconds ?? 35;

        // 2. Resolve hotel codes from DB
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
        }

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

        const allHotelCodes = dbHotels.map((h) => h.hotelCode);

        // 3. Call WBE in chunks of MAX_HOTEL_IDS_PER_CALL
        const chunks: string[][] = [];
        for (let i = 0; i < allHotelCodes.length; i += MAX_HOTEL_IDS_PER_CALL) {
            chunks.push(allHotelCodes.slice(i, i + MAX_HOTEL_IDS_PER_CALL));
        }

        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);

        const chunkResults = await Promise.all(
            chunks.map((hotelIds) =>
                wbeClientService.searchAndGetByHotelsV2({
                    HotelIds: hotelIds,
                    CheckInDate: checkinDate,
                    Nights: nights,
                    // Live API uses 'Waitseconds' (lowercase 's') — confirmed from actual API call
                    Waitseconds: waitSeconds,
                    CurrencyCode: currencyCode,
                    NationalityCode: nationalityCode,
                    Rooms: buildSearchRooms(),
                }).catch((err: any) => {
                    logger.error({ requestId, error: err.message, hotelIds }, 'WBE search chunk failed');
                    return null;
                }),
            ),
        );

        // 4. Merge chunk results; session-level poll for Finished: false
        // Key fix: WBE returns hotels under 'Data', not 'Hotels'
        const mergedHotels: any[] = [];
        let globalSessionId = '';
        let finished = true;

        for (const result of chunkResults) {
            if (!result) continue;

            const sessionId = field<string>(result, 'SessionID', 'sessionId', 'SessionId') ?? '';
            if (!globalSessionId) globalSessionId = sessionId;

            const isFinished = field<boolean>(result, 'Finished', 'finished') ?? true;

            // Live API: hotel data is in 'Data' array (not 'Hotels')
            const hotels = field<any[]>(result, 'Data', 'data', 'Hotels', 'hotels') ?? [];
            mergedHotels.push(...hotels);

            if (!isFinished && sessionId) {
                finished = false;
                const polledHotels = await this.pollUntilFinished(sessionId);
                mergedHotels.push(...polledHotels);
            }
        }

        // 5. Option B: per-option UpdatedOptionsNeeded refresh
        //    After initial collection, if any hotel has options with UpdatedOptionsNeeded: true,
        //    poll GetUpdatedOptions once more to get fresh data and merge it in.
        if (globalSessionId) {
            const hasStaleOptions = mergedHotels.some((h) =>
                (field<any[]>(h, 'Options', 'options') ?? []).some(
                    (o: any) => field<boolean>(o, 'UpdatedOptionsNeeded', 'updatedOptionsNeeded') === true,
                ),
            );

            if (hasStaleOptions) {
                logger.info({ requestId, sessionId: globalSessionId }, 'Polling for UpdatedOptionsNeeded options');
                const refreshed = await this.pollUntilFinished(globalSessionId);
                // Replace stale hotel entries with refreshed ones (matched by HotelCode)
                const refreshMap = new Map<string, any>();
                for (const h of refreshed) {
                    const code = field<string>(h, 'HotelCode', 'hotelCode') ?? '';
                    if (code) refreshMap.set(code, h);
                }
                for (let i = 0; i < mergedHotels.length; i++) {
                    const code = field<string>(mergedHotels[i], 'HotelCode', 'hotelCode') ?? '';
                    if (refreshMap.has(code)) mergedHotels[i] = refreshMap.get(code);
                }
            }
        }

        // Build DB lookup map for enriching results
        const dbHotelMap = await hotelSearchRepository.getHotelsByCode(
            mergedHotels.map((h) => field<string>(h, 'HotelCode', 'hotelCode') ?? '').filter(Boolean),
        );

        // Step 2.3: Determine dominant room type from request (for room type filter).
        // EC3 (mixed room types) is handled by running the loop per room type —
        // for now we use the dominant type as primary filter. TODO: full EC3 implementation.
        const dominantRoomType = getDominantRoomType((request as any).rooms);

        // 6. Process each hotel
        const primaryResults: HotelResult[] = [];
        const alternativeResults: HotelResult[] = [];

        for (const wbeHotel of mergedHotels) {
            const hotelCode = field<string>(wbeHotel, 'HotelCode', 'hotelCode', 'Code') ?? '';
            if (!hotelCode) continue;

            const rawOptions: any[] = field<any[]>(wbeHotel, 'Options', 'options') ?? [];
            const allOptions = parseWbeOptions(rawOptions, nights);

            // Filter 1: Only group-allowed suppliers
            const groupAllowed = allOptions.filter((o) => isGroupAllowed(o.supplierCode));

            // Filter 2: Free cancellation only (mandatory for groups)
            const freeCxlOptions = groupAllowed.filter((o) => o.freeCancellation);

            // Filter 3: Exclude on-request options (groups need instant confirmation)
            const confirmedOptions = freeCxlOptions.filter((o) => !o.onRequest);

            // Filter 4: Meal type (if specified)
            const mealFiltered = params.mealType
                ? confirmedOptions.filter((o) => o.mealType?.toUpperCase() === params.mealType!.toUpperCase())
                : confirmedOptions;

            if (mealFiltered.length === 0) continue;

            // Filter 5 (Step 2.3): Room type filter with Oliver's flexibility rules.
            // Single→Twin, Double→Twin, Triple→Quad. If dominant type is null → no filter.
            const roomTypeFiltered = mealFiltered.filter(
                (o) => matchesRoomType(o.roomDescriptions, dominantRoomType),
            );
            if (roomTypeFiltered.length === 0) continue;

            // Filter 6 (Step 2.3): Supplier deduplication — one entry per supplier, lowest price wins.
            const dedupedOptions = deduplicateBySupplier(roomTypeFiltered);

            // Step 2.4: Mid-range price band (skip bottom 20% + top 20%)
            const prices = dedupedOptions.map((o) => o.pricePerRoomPerNight);
            const midPrices = selectMidRange(prices);
            const selectedOptions = dedupedOptions.filter((o) => midPrices.includes(o.pricePerRoomPerNight));
            const optionsForCapacity = selectedOptions.length > 0 ? selectedOptions : dedupedOptions;
            const highestMidRangePrice = midPrices.length > 0 ? Math.max(...midPrices) : undefined;

            // Enrich with DB info (needed for Steps 3.1 + 3.2)
            const dbHotel = dbHotelMap.get(hotelCode);
            const hotelTotalRooms = dbHotel?.totalRooms ?? null;

            // Steps 3.1 + 3.2: Capacity check + inventory overlap detection.
            // rooms_still_needed = totalRooms for the agent search view (show full picture).
            const { contribution, inventoryOverlapFlag, overlapDetected, note: capacityNote } =
                computeHotelContribution(optionsForCapacity, hotelTotalRooms, totalRooms, totalRooms);

            // Determine include / flag / omit status for the agent UI
            const { status, note: statusNote } = determineStatus(contribution, totalRooms, false);
            const note = capacityNote ?? statusNote;

            // Step 3.3: Build supplier split (A2) using getCappedMax (HPG capped at 40%)
            const supplierSplit = status !== 'omit'
                ? buildSupplierSplit(optionsForCapacity, contribution, totalRooms)
                : [];

            const hotelName =
                field<string>(wbeHotel, 'HotelName', 'hotelName', 'Name', 'name') ??
                dbHotel?.name ??
                hotelCode;

            const starRating =
                field<number>(wbeHotel, 'StarRating', 'starRating', 'Stars') ??
                (dbHotel?.starRating ? Number(dbHotel.starRating) : null);

            // Image URL — decode DB key (already URL-encoded) then re-encode once to avoid double-encoding
            const rawImageKey = dbHotel?.primaryImageKey ?? null;
            let imageUrl: string | null = null;
            if (rawImageKey) {
                let decodedKey = rawImageKey;
                try { decodedKey = decodeURIComponent(rawImageKey); } catch { /* malformed — use as-is */ }
                imageUrl = `/api/v1/hotels/image?key=${encodeURIComponent(decodedKey)}`;
            }
            const address = field<string>(wbeHotel, 'Address', 'address', 'Location') ?? null;

            // Build bestOption — cheapest mid-range option (for frontend card + option-details call)
            const cheapestMidRange = selectedOptions.length > 0
                ? [...selectedOptions].sort((a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight)[0]
                : [...dedupedOptions].sort((a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight)[0];

            const bestOption: HotelBestOption | undefined = cheapestMidRange
                ? {
                      tid: cheapestMidRange.tid,
                      sessionId: globalSessionId,
                      supplierCode: cheapestMidRange.supplierCode,
                      buyingPricePerRoomPerNight: cheapestMidRange.pricePerRoomPerNight,
                      currency: cheapestMidRange.currency,
                      freeCancellation: cheapestMidRange.freeCancellation,
                      cancelDeadline: cheapestMidRange.cancelDeadline ?? null,
                      mealType: cheapestMidRange.mealType,
                      mealName: cheapestMidRange.mealName,
                      roomDescriptions: cheapestMidRange.roomDescriptions,
                  }
                : undefined;

            const hotelResult: HotelResult = {
                hotelCode,
                hotelName,
                starRating,
                imageUrl,
                address,
                addressCity: dbHotel?.addressCity ?? null,
                addressCountry: dbHotel?.addressCountry ?? null,
                sessionId: globalSessionId,
                status,
                totalRooms: hotelTotalRooms,
                roomsAllocated: contribution,
                inventoryOverlapFlag: inventoryOverlapFlag || overlapDetected,
                totalAvailableRooms: contribution,
                highestMidRangePrice,
                currency: dedupedOptions[0]?.currency,
                bestOption,
                usableOptions: dedupedOptions,
                selectedOptions,
                supplierSplit,
                note,
            };

            if (primaryHotelCodes.has(hotelCode)) {
                primaryResults.push(hotelResult);
            } else {
                alternativeResults.push(hotelResult);
            }
        }

        // Sort: included first, then flagged, then omitted; price asc within each group
        const sortResults = (arr: HotelResult[]) =>
            arr.sort((a, b) => {
                const order = { include: 0, flag: 1, omit: 2 };
                const statusDiff = order[a.status] - order[b.status];
                if (statusDiff !== 0) return statusDiff;
                return (a.highestMidRangePrice ?? 0) - (b.highestMidRangePrice ?? 0);
            });

        const sortedPrimary = sortResults(primaryResults);
        const sortedAlternative = sortResults(alternativeResults);

        const allResults = [...sortedPrimary, ...sortedAlternative];

        logger.info(
            {
                requestId,
                destinationId,
                totalHotelsFromWBE: mergedHotels.length,
                included: allResults.filter((r) => r.status === 'include').length,
                flagged: allResults.filter((r) => r.status === 'flag').length,
                omitted: allResults.filter((r) => r.status === 'omit').length,
            },
            'Hotel search complete',
        );

        return {
            requestId,
            sessionId: globalSessionId,
            finished,
            totalRoomsRequested: totalRooms,
            results: sortedPrimary,
            alternativeResults: sortedAlternative,
            summary: {
                total: allResults.length,
                included: allResults.filter((r) => r.status === 'include').length,
                flagged: allResults.filter((r) => r.status === 'flag').length,
                omitted: allResults.filter((r) => r.status === 'omit').length,
            },
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
     * Full PDF accumulation loop — Steps 2.1–4.2.
     *
     * Searches candidate hotels ONE AT A TIME (sequentially), applying all
     * Oliver filters (2.2–2.4), capacity + overlap checks (3.1–3.2), A2 supplier
     * split (3.3), and inline option details (3.4), accumulating committed rooms
     * until the group size is met or all candidates are exhausted.
     *
     * Step 4.1: Unified buying price = MAX(pricePerRoomPerNight) across ALL
     * supplier-split entries across ALL accepted hotels.
     * Customer sees ONE price = buying_price_base × (1 + markup) + psychology.
     *
     * Used by offerGeneration.service.ts for webhook-triggered auto offers.
     */
    async generateAutoOffer(
        requestId: string,
        params: HotelSearchParams & { markupPercent?: number } = {},
    ): Promise<AutoOfferResult> {
        // ── 1. Load request ──────────────────────────────────────────────────
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
        const waitSeconds = params.waitSeconds ?? 35;
        const markupPercent = params.markupPercent ?? 18;
        const dominantRoomType = getDominantRoomType((request as any).rooms);

        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);

        // ── 2. Resolve candidate hotels from DB (primary stars first) ────────
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
            return {
                success: false,
                requestId,
                roomsNeeded: totalRooms,
                roomsCommitted: 0,
                currency: currencyCode,
                nights,
                validatedHotels: [],
                escalation: {
                    roomsMissing: totalRooms,
                    partialHotels: [],
                    suggestion: 'No hotels found in database for this destination and star rating.',
                },
            };
        }

        // Primary star hotels first, then alternatives
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

        const sortedDbHotels = [
            ...dbHotels.filter((h) => primaryHotelCodes.has(h.hotelCode)),
            ...dbHotels.filter((h) => !primaryHotelCodes.has(h.hotelCode)),
        ];

        // ── 3. Sequential accumulation loop ─────────────────────────────────
        const validatedHotels: AutoOfferHotel[] = [];
        let roomsCommitted = 0;

        for (const dbHotel of sortedDbHotels) {
            if (roomsCommitted >= totalRooms) break;

            const roomsStillNeeded = totalRooms - roomsCommitted;

            // Step 2.1: WBE search — always SEARCH_ROOMS=3, single hotel
            let wbeResult: any = null;
            try {
                wbeResult = await wbeClientService.searchAndGetByHotelsV2({
                    HotelIds: [dbHotel.hotelCode],
                    CheckInDate: checkinDate,
                    Nights: nights,
                    Waitseconds: waitSeconds,
                    CurrencyCode: currencyCode,
                    NationalityCode: nationalityCode,
                    Rooms: buildSearchRooms(),
                });
            } catch (err: any) {
                logger.warn(
                    { requestId, hotelCode: dbHotel.hotelCode, error: err.message },
                    'WBE single-hotel search failed — skipping',
                );
                continue;
            }

            if (!wbeResult) continue;

            const sessionId = field<string>(wbeResult, 'SessionID', 'sessionId', 'SessionId') ?? '';
            const isFinished = field<boolean>(wbeResult, 'Finished', 'finished') ?? true;
            let hotelEntries: any[] = field<any[]>(wbeResult, 'Data', 'data', 'Hotels', 'hotels') ?? [];

            // Poll session if not finished
            if (!isFinished && sessionId) {
                const polled = await this.pollUntilFinished(sessionId);
                hotelEntries.push(...polled);
            }

            // Refresh stale UpdatedOptionsNeeded entries
            if (sessionId) {
                const hasStale = hotelEntries.some((h) =>
                    (field<any[]>(h, 'Options', 'options') ?? []).some(
                        (o: any) => field<boolean>(o, 'UpdatedOptionsNeeded', 'updatedOptionsNeeded') === true,
                    ),
                );
                if (hasStale) {
                    const refreshed = await this.pollUntilFinished(sessionId);
                    const refreshMap = new Map<string, any>();
                    for (const h of refreshed) {
                        const code = field<string>(h, 'HotelCode', 'hotelCode') ?? '';
                        if (code) refreshMap.set(code, h);
                    }
                    for (let i = 0; i < hotelEntries.length; i++) {
                        const code = field<string>(hotelEntries[i], 'HotelCode', 'hotelCode') ?? '';
                        if (refreshMap.has(code)) hotelEntries[i] = refreshMap.get(code);
                    }
                }
            }

            const wbeHotel = hotelEntries.find(
                (h) => (field<string>(h, 'HotelCode', 'hotelCode', 'Code') ?? '') === dbHotel.hotelCode,
            );
            if (!wbeHotel) continue;

            // Steps 2.2–2.4: Filter pipeline
            const allOptions = parseWbeOptions(field<any[]>(wbeHotel, 'Options', 'options') ?? [], nights);

            const groupAllowed = allOptions.filter((o) => isGroupAllowed(o.supplierCode));
            const freeCxlOptions = groupAllowed.filter((o) => o.freeCancellation);
            const confirmedOptions = freeCxlOptions.filter((o) => !o.onRequest);
            const mealFiltered = params.mealType
                ? confirmedOptions.filter((o) => o.mealType?.toUpperCase() === params.mealType!.toUpperCase())
                : confirmedOptions;

            if (mealFiltered.length === 0) continue;

            const roomTypeFiltered = mealFiltered.filter((o) => matchesRoomType(o.roomDescriptions, dominantRoomType));
            if (roomTypeFiltered.length === 0) continue;

            const dedupedOptions = deduplicateBySupplier(roomTypeFiltered);
            const prices = dedupedOptions.map((o) => o.pricePerRoomPerNight);
            const midPrices = selectMidRange(prices);
            const selectedOptions = dedupedOptions.filter((o) => midPrices.includes(o.pricePerRoomPerNight));
            const optionsForCapacity = selectedOptions.length > 0 ? selectedOptions : dedupedOptions;

            // Steps 3.1 + 3.2: Capacity check + inventory overlap
            const hotelTotalRooms = dbHotel.totalRooms ?? null;
            const { contribution, inventoryOverlapFlag, overlapDetected, note: capacityNote } =
                computeHotelContribution(optionsForCapacity, hotelTotalRooms, totalRooms, roomsStillNeeded);

            if (contribution <= 0) continue; // Step 3.5: hotel can't contribute — skip

            // Step 3.3: A2 supplier split
            const supplierSplit = buildSupplierSplit(optionsForCapacity, contribution, totalRooms);
            if (supplierSplit.length === 0) continue;

            // Step 3.4: Fetch option details for cheapest A2 entry (get cxlDeadline)
            let cxlDeadline: string | null = null;
            if (sessionId) {
                const cheapestSplit = [...supplierSplit].sort(
                    (a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight,
                )[0];
                try {
                    const [detail] = await this.fetchOptionDetails([{
                        sessionId,
                        tid: cheapestSplit.tid,
                        hotelCode: dbHotel.hotelCode,
                    }]);
                    cxlDeadline = detail?.parsed?.cxlDeadline ?? null;
                } catch (err: any) {
                    logger.warn(
                        { requestId, hotelCode: dbHotel.hotelCode, error: err.message },
                        'OptionDetailsV2 failed in accumulation loop — no cxl date',
                    );
                }
            }

            // Step 3.5: Accept hotel — build image URL the same way as searchForRequest
            const rawImageKey = dbHotel.primaryImageKey ?? null;
            let imageUrl: string | null = null;
            if (rawImageKey) {
                let decodedKey = rawImageKey;
                try { decodedKey = decodeURIComponent(rawImageKey); } catch { /* use as-is */ }
                imageUrl = `/api/v1/hotels/image?key=${encodeURIComponent(decodedKey)}`;
            }

            validatedHotels.push({
                hotelCode: dbHotel.hotelCode,
                hotelName: dbHotel.name,
                starRating: dbHotel.starRating ? Number(dbHotel.starRating) : null,
                imageUrl,
                address: null,
                addressCity: dbHotel.addressCity ?? null,
                addressCountry: dbHotel.addressCountry ?? null,
                roomsAllocated: contribution,
                cxlDeadline,
                inventoryOverlapFlag: inventoryOverlapFlag || overlapDetected,
                note: capacityNote,
                supplierSplit,
            });

            roomsCommitted += contribution;

            logger.info(
                { requestId, hotelCode: dbHotel.hotelCode, contribution, roomsCommitted, totalRooms },
                'Hotel accepted in auto-offer accumulation loop',
            );
        }

        // ── Escalation: not enough rooms found ───────────────────────────────
        if (roomsCommitted < totalRooms) {
            logger.warn({ requestId, roomsCommitted, totalRooms }, 'Auto-offer escalation — insufficient capacity');
            return {
                success: false,
                requestId,
                roomsNeeded: totalRooms,
                roomsCommitted,
                currency: currencyCode,
                nights,
                validatedHotels,
                escalation: {
                    roomsMissing: totalRooms - roomsCommitted,
                    partialHotels: validatedHotels,
                    suggestion: `Only ${roomsCommitted} of ${totalRooms} rooms could be sourced from available hotels. Manual review required.`,
                },
            };
        }

        // ── Step 4.1: Unified pricing ─────────────────────────────────────────
        // Buying price base = MAX supplier price across ALL A2 entries for ALL accepted hotels.
        // This ensures the customer price covers the most expensive split.
        const allSplitPrices = validatedHotels.flatMap((h) =>
            h.supplierSplit.map((s) => s.pricePerRoomPerNight),
        );
        const buyingPriceBase = allSplitPrices.length > 0 ? Math.max(...allSplitPrices) : 0;

        const { sellPrice: sellingPricePerRoomPerNight } = this.calculateSellPrice(buyingPriceBase, markupPercent);
        const totalOfferPrice = sellingPricePerRoomPerNight * totalRooms * nights;

        logger.info(
            {
                requestId,
                hotelsAccepted: validatedHotels.length,
                roomsCommitted,
                buyingPriceBase,
                sellingPricePerRoomPerNight,
                totalOfferPrice,
                markupPercent,
            },
            'Auto-offer generation complete',
        );

        return {
            success: true,
            requestId,
            roomsNeeded: totalRooms,
            roomsCommitted,
            currency: currencyCode,
            nights,
            validatedHotels,
            buyingPriceBase,
            sellingPricePerRoomPerNight,
            totalOfferPrice,
            markupPercent,
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
