

import { randomUUID } from 'crypto';
import requestRepository from '../repositories/request.repository';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import wbeClientService from './wbe.client.service';
import { publishHotelProbeJob } from '../queue/hotelProbe.publisher';
import logger from '../utils/logger';
import { normalisePricePerRoomPerNight } from '../utils/pricing';
import { getSupplierMaxRooms, isGroupAllowed, getCappedMax } from '../config/supplierLimits';
import { PROBE_BATCH_SIZE, PROBE_MULTIPLIER, PROBE_WAIT_SECONDS, ROOM_TYPE_ADULTS } from '../config/probeConfig';
import type { ExpandedRoom, RoomTypeProbeTarget } from '../queue/hotelProbeJob.types';
import { countTotalRooms, hasNewDoubleBreakdown, normalizeRoomCounts } from '../utils/roomUtils';
import {
    RELAXATION_LADDER,
    buildStarList,
    describeRelaxation,
    describeDestinationFallback,
    describeAlternativeReason,
    type RelaxationLevel,
} from './searchRelaxation';
import { logAuditEvent } from '../utils/audit';
import { BookingRequestStatus } from '@prisma/client';
import { broadcast } from './sseManager';

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
    /** Filter hotels by facility/amenity IDs. Only hotels with ALL listed facilities are included. */
    facilityIds?: number[];
    /** Frontend portal language. Determines GIATA description language returned per hotel. */
    lang?: 'en' | 'de';
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
    description?: string | null;
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
    /**
     * Set when the search auto-relaxed filters because exact criteria returned zero
     * hotels. Frontend should show a banner ("We couldn't find exact matches…").
     */
    relaxation?: {
        level: import('./searchRelaxation').RelaxationLevel;
        bannerMessage: string;
    } | null;
    /**
     * Set when the search fell back to a wider destination (parent / country / nearby)
     * because the requested destination + relaxed filters still returned zero.
     */
    destinationFallback?: {
        originalDestinationId: number;
        originalDestinationName: string;
        usedDestinationId: number;
        usedDestinationName: string;
        bannerMessage: string;
    } | null;
    /**
     * True when even the destination fallback returned zero hotels. Frontend
     * should show a "Submit manual request" CTA so the user is never left
     * with a dead end.
     */
    manualRequestOnly?: boolean;
    /**
     * @deprecated The backend no longer computes this — the FE decides locally
     * by counting successful (COMPLETED) probe jobs after they all terminate:
     * show the "Show Alternatives" button when 1 ≤ successfulCount ≤ 4.
     * Kept on the type for backwards-compatibility; always undefined now.
     */
    hasAlternativesAvailable?: boolean;
    /**
     * True when this call hit the in-flight guard — a previous search was
     * still running when the FE re-clicked "Search". The backend did NOT
     * start a fresh search; the FE should keep polling /status or stay on
     * the existing SSE connection.
     */
    alreadyInFlight?: boolean;
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
    // Normalize to avoid double-counting double/twin when new breakdown fields are present
    const normalized = normalizeRoomCounts(rooms);
    const expanded: ExpandedRoom[] = [];
    for (const [type, count] of Object.entries(normalized)) {
        const n = Number(count) || 0;
        if (n <= 0) continue;
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
    // Normalize to avoid double-counting double/twin when new breakdown fields are present
    const normalized = normalizeRoomCounts(rooms);
    const targets: RoomTypeProbeTarget[] = [];
    for (const [type, count] of Object.entries(normalized)) {
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
// normalisePricePerRoomPerNight moved to src/utils/pricing.ts (shared with the probe worker).

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

    const useNewBreakdown = hasNewDoubleBreakdown(rooms);

    const types = [
        // Legacy double/twin — only counted when new breakdown fields are absent
        { type: 'double',            count: useNewBreakdown ? 0 : (rooms.double ?? 0) },
        { type: 'twin',              count: useNewBreakdown ? 0 : (rooms.twin ?? 0) },
        // New breakdown fields
        { type: 'standardDoubleBeds', count: rooms.standardDoubleBeds ?? 0 },
        { type: 'twinBeds',          count: rooms.twinBeds ?? 0 },
        // Other types — always counted
        { type: 'single',            count: rooms.single ?? 0 },
        { type: 'triple',            count: rooms.triple ?? 0 },
        { type: 'quadruple',         count: rooms.quadruple ?? 0 },
        { type: 'suite',             count: rooms.suites ?? 0 },
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

        // Use the actual number of rooms WBE returned in this option (not a hardcoded batch size).
        // WBE can return options with fewer rooms than requested when partial availability exists.
        const roomsInOption = rawRooms.length > 0 ? rawRooms.length : SEARCH_ROOMS;
        const pricePerRoomPerNight = normalisePricePerRoomPerNight(rawPrice, roomsInOption, nights, { tid, supplierCode });
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
     * "Never say no" candidate selection — Oliver's approved pipeline.
     *
     * 1. Walks the RELAXATION_LADDER for the original destination, returning
     *    the first level that yields ≥ 1 candidate hotel.
     * 2. If all levels return zero, walks the destination chain
     *    (parent → country → nearby) and tries the full ladder at each.
     * 3. If everything still returns zero, signals manualRequestOnly so the
     *    frontend can show a "submit manual request" CTA instead of a dead end.
     *
     * Travel dates are NEVER altered — Oliver explicitly rejected flexible dates.
     */
    private async findCandidatesWithRelaxation(opts: {
        destinationId: number;
        requestedStarRating: number | null;
        facilityIds?: number[];
        /**
         * For the ORIGINAL destination only, skip ladder levels < this index.
         * Used by the post-probe relaxation watcher to advance one level at a
         * time when prior probe results came back empty. Fallback destinations
         * (parent / country / nearby) always start the ladder at 0.
         * Defaults to 0 (full ladder).
         */
        startLevelIndex?: number;
    }): Promise<{
        candidates: Awaited<ReturnType<typeof hotelSearchRepository.getHotelCodesByDestination>>;
        appliedLevel: RelaxationLevel;
        usedDestinationId: number;
        manualRequestOnly: boolean;
    }> {
        const startIdx = Math.max(0, Math.min(opts.startLevelIndex ?? 0, RELAXATION_LADDER.length - 1));

        const tryAtDestination = async (destId: number, fromIndex: number) => {
            for (let i = fromIndex; i < RELAXATION_LADDER.length; i++) {
                const config = RELAXATION_LADDER[i]!;
                const stars = buildStarList(opts.requestedStarRating, config.starWindow);
                let dbHotels = await hotelSearchRepository.getHotelCodesByDestination(destId, stars);
                if (dbHotels.length === 0) continue;

                if (config.keepFacilities && opts.facilityIds && opts.facilityIds.length > 0) {
                    const allCodes = dbHotels.map((h) => h.hotelCode);
                    const matchingCodes = await hotelSearchRepository.filterHotelCodesByFacilities(
                        allCodes,
                        opts.facilityIds,
                    );
                    const matchingSet = new Set(matchingCodes);
                    dbHotels = dbHotels.filter((h) => matchingSet.has(h.hotelCode));
                }

                if (dbHotels.length > 0) {
                    return { candidates: dbHotels, level: config.level };
                }
            }
            return null;
        };

        // 1. Try the original destination through the ladder, starting at startIdx.
        const direct = await tryAtDestination(opts.destinationId, startIdx);
        if (direct) {
            return {
                candidates: direct.candidates,
                appliedLevel: direct.level,
                usedDestinationId: opts.destinationId,
                manualRequestOnly: false,
            };
        }

        // 2. Build the destination fallback chain: parent → country → nearby.
        // Fallback destinations always run the FULL ladder (start at 0) — they're
        // wider areas, not subject to the "we already tried lower levels" logic.
        const ancestry = await hotelSearchRepository.getDestinationAncestry(opts.destinationId);
        const nearby = await hotelSearchRepository.getNearbyDestinations(opts.destinationId, 5);
        const fallbackChain = [...ancestry, ...nearby];

        for (const destId of fallbackChain) {
            const result = await tryAtDestination(destId, 0);
            if (result) {
                return {
                    candidates: result.candidates,
                    appliedLevel: result.level,
                    usedDestinationId: destId,
                    manualRequestOnly: false,
                };
            }
        }

        // 3. Nothing worked anywhere — surface manualRequestOnly.
        return {
            candidates: [],
            appliedLevel: 'facilities_dropped',
            usedDestinationId: opts.destinationId,
            manualRequestOnly: true,
        };
    }

    // ─── Post-probe relaxation watcher ───────────────────────────────────
    // Fires only when probes complete with ZERO successful hotels. Advances
    // the relaxation ladder one step, deletes failed probes, queues fresh
    // ones at the wider criteria. Repeats until either probes succeed or
    // the ladder is exhausted (then status → needs_manual_handling).
    //
    // Does NOT fire when the user has 1+ successful hotels — that case is
    // handled by the user-driven "Show Alternatives" button.

    /**
     * Poll probe jobs for a search request until all reach a terminal state
     * (or timeout). Returns the success count + total count once done.
     */
    private async waitForProbeJobsToTerminate(
        requestId: string,
    ): Promise<{ successCount: number; totalCount: number; timedOut: boolean }> {
        const TERMINAL = new Set(['COMPLETED', 'SKIPPED_INSUFFICIENT', 'FAILED']);
        const POLL_INTERVAL_MS = 5_000;
        const MAX_WAIT_MS = 5 * 60 * 1000; // 5 min per relaxation iteration

        const start = Date.now();
        while (Date.now() - start < MAX_WAIT_MS) {
            const jobs = await hotelProbeJobRepository.findBySearchRequest(requestId);
            if (jobs.length === 0) {
                return { successCount: 0, totalCount: 0, timedOut: false };
            }
            // Only consider 'main' probes — alternatives are user-driven and
            // the watcher's job is to advance the MAIN search ladder.
            const mainJobs = jobs.filter((j: any) => (j.searchKind ?? 'main') === 'main');
            if (mainJobs.length === 0) {
                return { successCount: 0, totalCount: 0, timedOut: false };
            }
            const allTerminal = mainJobs.every((j: any) => TERMINAL.has(j.status));
            if (allTerminal) {
                return {
                    successCount: mainJobs.filter((j: any) => j.status === 'COMPLETED').length,
                    totalCount: mainJobs.length,
                    timedOut: false,
                };
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        // Timed out — return whatever we have
        const jobs = await hotelProbeJobRepository.findBySearchRequest(requestId);
        const mainJobs = jobs.filter((j: any) => (j.searchKind ?? 'main') === 'main');
        return {
            successCount: mainJobs.filter((j: any) => j.status === 'COMPLETED').length,
            totalCount: mainJobs.length,
            timedOut: true,
        };
    }

    /**
     * Background watcher that advances the relaxation ladder one step at a
     * time when probes return zero successful hotels. Spawned as fire-and-
     * forget from `searchForRequest`. Recurses by re-calling `searchForRequest`
     * with `suppressWatcher: true` so we don't spawn nested watchers.
     *
     * Critically: only advances when successCount === 0. If even 1 main hotel
     * succeeds, the user is shown the "Show Alternatives" button instead and
     * the watcher exits silently.
     */
    private async runPostProbeRelaxation(
        requestId: string,
        params: HotelSearchParams,
        startLevel: RelaxationLevel,
    ): Promise<void> {
        let currentLevel: RelaxationLevel = startLevel;
        const MAX_ITERATIONS = RELAXATION_LADDER.length;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            const probeResult = await this.waitForProbeJobsToTerminate(requestId);

            // 1+ probe succeeded — exit. User has hotels to look at; if there
            // are between 1 and 4 the FE will offer "Show Alternatives".
            if (probeResult.successCount > 0) {
                logger.info(
                    { requestId, level: currentLevel, successCount: probeResult.successCount },
                    'Post-probe relaxation: probes succeeded — watcher exiting',
                );
                broadcast(requestId, 'searchSettled', {
                    requestId,
                    finalLevel: currentLevel,
                    successCount: probeResult.successCount,
                    totalCount: probeResult.totalCount,
                });
                return;
            }

            if (probeResult.timedOut) {
                logger.warn(
                    { requestId, level: currentLevel },
                    'Post-probe relaxation: timed out waiting for probes — watcher exiting',
                );
                return;
            }

            if (probeResult.totalCount === 0) {
                logger.info(
                    { requestId, level: currentLevel },
                    'Post-probe relaxation: no probes found for this request — watcher exiting',
                );
                return;
            }

            // Zero successes — advance the relaxation ladder.
            const currentIndex = RELAXATION_LADDER.findIndex((l) => l.level === currentLevel);
            const nextIndex = currentIndex + 1;
            if (currentIndex < 0 || nextIndex >= RELAXATION_LADDER.length) {
                // Ladder exhausted — flag as needs_manual_handling.
                logger.info(
                    { requestId, level: currentLevel },
                    'Post-probe relaxation: ladder exhausted — flagging as needs_manual_handling',
                );
                await requestRepository.updateStatus(
                    requestId,
                    BookingRequestStatus.needs_manual_handling,
                );
                broadcast(requestId, 'searchExhausted', {
                    requestId,
                    finalLevel: currentLevel,
                });
                return;
            }

            const nextLevel = RELAXATION_LADDER[nextIndex]!.level;
            logger.info(
                { requestId, fromLevel: currentLevel, toLevel: nextLevel },
                'Post-probe relaxation: advancing level',
            );
            await logAuditEvent({
                action: 'search_post_probe_relaxation',
                entity: 'booking_request',
                entityId: requestId,
                details: { fromLevel: currentLevel, toLevel: nextLevel, iteration: iter + 1 },
            });

            // Notify the FE so it can update banners / loading copy.
            broadcast(requestId, 'searchRelaxed', {
                requestId,
                fromLevel: currentLevel,
                toLevel: nextLevel,
                iteration: iter + 1,
            });

            // Re-run the search starting at the next level. suppressWatcher: true
            // prevents this from spawning ANOTHER watcher (we drive the loop here).
            const result = await this.searchForRequest(requestId, params, {
                startLevelIndex: nextIndex,
                suppressWatcher: true,
            });

            if (result.manualRequestOnly) {
                // No candidates at this or further levels — searchForRequest
                // already updated status to needs_manual_handling.
                logger.info(
                    { requestId, level: nextLevel },
                    'Post-probe relaxation: re-search returned manualRequestOnly — watcher exiting',
                );
                return;
            }

            const newAppliedLevel: RelaxationLevel | undefined = result.relaxation?.level
                ?? RELAXATION_LADDER[nextIndex]?.level;
            currentLevel = newAppliedLevel ?? nextLevel;
        }
    }

    /**
     * Queue-based hotel search orchestration for a booking request.
     *
     * Dispatches one HotelProbeJob per candidate hotel to RabbitMQ.
     * Each job probes R1-R3, R4-R6, R7-R9 … sequentially until capacity is confirmed.
     * Returns immediately — results arrive via SSE (GET /requests/:id/hotel-search/events)
     * or polling (GET /requests/:id/hotel-search/status).
     *
     * Spawns a background post-probe relaxation watcher: if all probes return
     * SKIPPED_INSUFFICIENT / FAILED (zero successful hotels), the watcher
     * automatically advances the relaxation ladder and re-queues until either
     * probes succeed OR the ladder is exhausted (status → needs_manual_handling).
     *
     * @param internalOpts INTERNAL — used by the post-probe watcher to recursively
     *                     re-trigger the search at higher levels without spawning
     *                     another nested watcher.
     */
    async searchForRequest(
        requestId: string,
        params: HotelSearchParams = {},
        internalOpts?: { startLevelIndex?: number; suppressWatcher?: boolean },
    ): Promise<HotelSearchQueueResponse> {
        // 1. Load request
        const request = await requestRepository.findById(requestId);
        if (!request) {
            throw { status: 404, message: 'Booking request not found', code: 'NOT_FOUND' };
        }

        // In-flight guard: if the FE re-clicks "Search" while a previous search
        // is still processing (probes in QUEUED/RUNNING/PROBING, or a watcher
        // is still iterating), DON'T spawn a duplicate search. Just return the
        // current snapshot. Skipped for internal recursive calls from the
        // watcher (those already own the in-flight slot).
        if (!internalOpts?.suppressWatcher) {
            const existingJobs = await hotelProbeJobRepository.findBySearchRequest(requestId);
            const liveJobs = existingJobs.filter((j: any) =>
                j.status === 'QUEUED' || j.status === 'RUNNING' || j.status === 'PROBING',
            );
            if (liveJobs.length > 0) {
                logger.info(
                    { requestId, liveCount: liveJobs.length },
                    'searchForRequest: search already in flight — returning current snapshot, skipping duplicate spawn',
                );
                return {
                    requestId,
                    totalCandidates: existingJobs.length,
                    jobsQueued: 0,
                    message: 'Search already in progress — subscribe to the SSE / status endpoint for updates.',
                    sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
                    statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
                    relaxation: null,
                    destinationFallback: null,
                    manualRequestOnly: false,
                    alreadyInFlight: true,
                };
            }
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

        // ── "Never say no" candidate selection ─────────────────────────────
        // Walks the relaxation ladder + destination fallback chain so we
        // surface the closest available options instead of a dead end.
        // (`includeAlternativeStars` is preserved for backwards-compat but
        //  is now superseded by the explicit ladder.)
        void includeAlternativeStars;
        const relaxResult = await this.findCandidatesWithRelaxation({
            destinationId,
            requestedStarRating,
            facilityIds: params.facilityIds,
            startLevelIndex: internalOpts?.startLevelIndex,
        });
        let dbHotels = relaxResult.candidates;

        // Build banner / fallback metadata for the response
        const relaxationBanner = describeRelaxation(relaxResult.appliedLevel);
        const usedDifferentDestination = relaxResult.usedDestinationId !== destinationId;
        let destinationFallbackInfo: HotelSearchQueueResponse['destinationFallback'] = null;
        if (usedDifferentDestination && dbHotels.length > 0) {
            const [origName, usedName] = await Promise.all([
                hotelSearchRepository.getDestinationName(destinationId),
                hotelSearchRepository.getDestinationName(relaxResult.usedDestinationId),
            ]);
            destinationFallbackInfo = {
                originalDestinationId: destinationId,
                originalDestinationName: origName ?? request.destinationName ?? '',
                usedDestinationId: relaxResult.usedDestinationId,
                usedDestinationName: usedName ?? '',
                bannerMessage: describeDestinationFallback(
                    dbHotels.length,
                    origName ?? request.destinationName ?? 'the requested area',
                    usedName ?? 'a wider area',
                ),
            };
        }

        // Audit log when relaxation actually kicked in (skip the "default" levels
        // exact / star_pm1 to avoid log spam — those are normal behaviour).
        if (
            relaxResult.appliedLevel !== 'exact' &&
            relaxResult.appliedLevel !== 'star_pm1'
        ) {
            await logAuditEvent({
                action: 'search_relaxation_applied',
                entity: 'booking_request',
                entityId: requestId,
                details: {
                    appliedLevel: relaxResult.appliedLevel,
                    fallbackDestinationId: usedDifferentDestination
                        ? relaxResult.usedDestinationId
                        : null,
                    candidateCount: dbHotels.length,
                    manualRequestOnly: relaxResult.manualRequestOnly,
                },
            });
        }

        if (dbHotels.length === 0) {
            // Total dead end — surface manualRequestOnly so the frontend
            // shows a "submit manual request" CTA instead of an empty page.
            logger.warn(
                { requestId, destinationId },
                'No hotels found at any relaxation level or fallback destination',
            );
            // Slice 2 — flag the request so staff sees the orange badge & banner.
            // Idempotent: only write when status is actually changing.
            if ((request as any).status !== BookingRequestStatus.needs_manual_handling) {
                await requestRepository.updateStatus(
                    requestId,
                    BookingRequestStatus.needs_manual_handling,
                );
            }
            broadcast(requestId, 'searchExhausted', {
                requestId,
                finalLevel: relaxResult.appliedLevel,
                reason: 'no_candidates',
            });
            return {
                requestId,
                totalCandidates: 0,
                jobsQueued: 0,
                message: 'No hotels available for this request — please submit a manual request.',
                sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
                statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
                relaxation: null,
                destinationFallback: null,
                manualRequestOnly: true,
            };
        }

        // Clean up old probe jobs from previous searches for this request
        await hotelProbeJobRepository.deleteBySearchRequest(requestId);

        // Dispatch one HotelProbeJob per hotel to RabbitMQ
        const roomTypeTargets = buildRoomTypeTargets((request as any).rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * PROBE_MULTIPLIER;
        let jobsQueued = 0;

        // If the relaxation pipeline reached level >= meal_dropped, drop the
        // mealType filter at probe time too (otherwise we'd lose hotels that
        // only have non-matching meal options).
        const RELAXED_PAST_MEAL: ReadonlySet<RelaxationLevel> = new Set<RelaxationLevel>([
            'meal_dropped',
            'location_dropped',
            'facilities_dropped',
        ]);
        const probeMealType = RELAXED_PAST_MEAL.has(relaxResult.appliedLevel)
            ? undefined
            : params.mealType;

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
                mealType: probeMealType,
                markupPercent,
                expandedRooms,
                dominantRoomType,
                roomTypeTargets,
                lang: params.lang,
            });
            jobsQueued++;
        }

        logger.info(
            {
                requestId,
                totalCandidates: dbHotels.length,
                jobsQueued,
                appliedLevel: relaxResult.appliedLevel,
                usedDestinationId: relaxResult.usedDestinationId,
            },
            'Hotel probe jobs queued',
        );

        // Slice 2 — auto-clear the manual-handling flag if a previous search
        // failed but this re-search (likely after staff edited dates / destination)
        // succeeded in finding candidates. Brings the request back to `pending`
        // so the orange badge / banner go away on the next page load.
        if ((request as any).status === BookingRequestStatus.needs_manual_handling) {
            await requestRepository.updateStatus(requestId, BookingRequestStatus.pending);
        }

        // Spawn the post-probe relaxation watcher (fire and forget). Skipped
        // when this call is itself a recursive re-trigger from the watcher
        // (otherwise we'd nest watchers infinitely).
        if (!internalOpts?.suppressWatcher) {
            setImmediate(() => {
                this.runPostProbeRelaxation(requestId, params, relaxResult.appliedLevel).catch(
                    (err) => {
                        logger.error(
                            { err: err?.message, requestId },
                            'Post-probe relaxation watcher crashed',
                        );
                    },
                );
            });
        }

        return {
            requestId,
            totalCandidates: dbHotels.length,
            jobsQueued,
            message: `${jobsQueued} hotel probe jobs queued. Subscribe to SSE for real-time updates.`,
            sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
            statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
            relaxation: relaxationBanner
                ? { level: relaxResult.appliedLevel, bannerMessage: relaxationBanner }
                : null,
            destinationFallback: destinationFallbackInfo,
            manualRequestOnly: false,
            // The "Show Alternatives" button is now FE-driven: shown when the
            // user has 1-4 successful hotels visible. Backend no longer guesses
            // because probe success counts aren't known at search time.
            hasAlternativesAvailable: undefined,
        };
    }

    /**
     * "Show alternatives" — user-triggered relaxed-criteria search.
     *
     * Triggered when the main search returned 1-4 successful hotels and the
     * user clicks the "Show alternatives" button on the FE. Walks the
     * RELAXATION_LADDER starting one level AFTER what the main search used, plus
     * the destination fallback chain (parent → country → nearby). Excludes
     * hotelCodes already returned by the main search so alternatives never
     * duplicate main results.
     *
     * Each alternative probe job is tagged with `searchKind: 'alternative'` and
     * an `alternativeReason` label so the FE can render them in a separate
     * "Similar alternatives" section with a contextual badge.
     */
    async searchAlternativesForRequest(
        requestId: string,
        params: HotelSearchParams = {},
        appliedLevelFromMain?: RelaxationLevel,
    ): Promise<HotelSearchQueueResponse> {
        // 1. Load and validate the request — same gate as searchForRequest.
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
        const waitSeconds = params.waitSeconds ?? PROBE_WAIT_SECONDS;
        const markupPercent = 18;

        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);

        const dominantRoomType = getDominantRoomType((request as any).rooms);
        const expandedRooms = expandRequestRooms((request as any).rooms);

        // 2. Find which hotelCodes are already in the main results — exclude them.
        const existingJobs = await hotelProbeJobRepository.findBySearchRequest(requestId);
        const excludedHotelCodes = new Set(
            existingJobs
                .filter((j: any) => (j.searchKind ?? 'main') === 'main')
                .map((j: any) => j.hotelCode),
        );

        // 3. Determine where on the ladder to start. If the main search ran at
        //    `exact`, alternatives start at `star_pm1`. If main is unknown, start at 0.
        let startIndex = 0;
        if (appliedLevelFromMain) {
            const mainIndex = RELAXATION_LADDER.findIndex((l) => l.level === appliedLevelFromMain);
            if (mainIndex >= 0) startIndex = mainIndex + 1;
        }

        // 4. Walk levels for the ORIGINAL destination, then the FALLBACK chain
        //    (parent / country / nearby). For each candidate, remember the
        //    relaxation level + whether the destination is a fallback so we
        //    can build per-hotel reason badges.
        type Candidate = {
            hotel: Awaited<ReturnType<typeof hotelSearchRepository.getHotelCodesByDestination>>[number];
            level: RelaxationLevel;
            fromFallbackDestination: boolean;
        };
        const found = new Map<string, Candidate>();

        const collectAtDestination = async (
            destId: number,
            isFallback: boolean,
            fromIndex: number,
        ) => {
            for (let i = fromIndex; i < RELAXATION_LADDER.length; i++) {
                const config = RELAXATION_LADDER[i]!;
                const stars = buildStarList(requestedStarRating, config.starWindow);
                let dbHotels = await hotelSearchRepository.getHotelCodesByDestination(destId, stars);

                if (config.keepFacilities && params.facilityIds && params.facilityIds.length > 0) {
                    const allCodes = dbHotels.map((h) => h.hotelCode);
                    const matchingCodes = await hotelSearchRepository.filterHotelCodesByFacilities(
                        allCodes,
                        params.facilityIds,
                    );
                    const matchingSet = new Set(matchingCodes);
                    dbHotels = dbHotels.filter((h) => matchingSet.has(h.hotelCode));
                }

                for (const h of dbHotels) {
                    if (excludedHotelCodes.has(h.hotelCode)) continue;
                    if (found.has(h.hotelCode)) continue; // first level wins
                    found.set(h.hotelCode, {
                        hotel: h,
                        level: config.level,
                        fromFallbackDestination: isFallback,
                    });
                }
            }
        };

        // Original destination — start at the level after main's applied level.
        await collectAtDestination(destinationId, false, startIndex);

        // Fallback destinations — full ladder from level 0.
        const ancestry = await hotelSearchRepository.getDestinationAncestry(destinationId);
        const nearby = await hotelSearchRepository.getNearbyDestinations(destinationId, 5);
        for (const destId of [...ancestry, ...nearby]) {
            await collectAtDestination(destId, true, 0);
        }

        if (found.size === 0) {
            logger.info(
                { requestId, destinationId, excludedCount: excludedHotelCodes.size },
                'No alternatives found',
            );
            return {
                requestId,
                totalCandidates: 0,
                jobsQueued: 0,
                message: 'No alternative hotels found for this request.',
                sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
                statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
                relaxation: null,
                destinationFallback: null,
                manualRequestOnly: false,
                hasAlternativesAvailable: false,
            };
        }

        // 5. Queue probe jobs for each alternative candidate. Use mealType=undefined
        //    so the probe filter is permissive — alternatives shouldn't be excluded
        //    by the original meal-type criterion (that's part of being alternatives).
        const roomTypeTargets = buildRoomTypeTargets((request as any).rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * PROBE_MULTIPLIER;
        let jobsQueued = 0;

        for (const candidate of found.values()) {
            const reason = describeAlternativeReason(candidate.level, candidate.fromFallbackDestination);
            const jobId = randomUUID();
            await hotelProbeJobRepository.create({
                id: jobId,
                searchRequestId: requestId,
                hotelCode: candidate.hotel.hotelCode,
                requestedRooms: totalRooms,
                probeLimit,
                searchKind: 'alternative',
                alternativeReason: reason,
            });
            await publishHotelProbeJob({
                jobId,
                searchRequestId: requestId,
                hotelCode: candidate.hotel.hotelCode,
                checkinDate,
                nights,
                requestedRooms: totalRooms,
                probeLimit,
                currencyCode,
                nationalityCode,
                waitSeconds,
                // Alternatives intentionally drop the user's original mealType so
                // we widen as much as possible at the probe stage too.
                mealType: undefined,
                markupPercent,
                expandedRooms,
                dominantRoomType,
                roomTypeTargets,
                searchKind: 'alternative',
                alternativeReason: reason,
                lang: params.lang,
            });
            jobsQueued++;
        }

        await logAuditEvent({
            action: 'search_alternatives_requested',
            entity: 'booking_request',
            entityId: requestId,
            details: {
                appliedLevelFromMain: appliedLevelFromMain ?? null,
                startIndex,
                excluded: excludedHotelCodes.size,
                alternativesQueued: jobsQueued,
            },
        });

        logger.info(
            { requestId, alternativesQueued: jobsQueued, excluded: excludedHotelCodes.size },
            'Alternative hotel probe jobs queued',
        );

        return {
            requestId,
            totalCandidates: jobsQueued,
            jobsQueued,
            message: `${jobsQueued} alternative hotel probe jobs queued.`,
            sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
            statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
            relaxation: null,
            destinationFallback: null,
            manualRequestOnly: false,
            hasAlternativesAvailable: false,
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
        void includeAlternativeStars; // superseded by the explicit relaxation ladder

        // ── "Never say no" candidate selection (auto-offer flow) ──────────
        const relaxResult = await this.findCandidatesWithRelaxation({
            destinationId: request.destinationId,
            requestedStarRating,
            facilityIds: params.facilityIds,
        });
        const dbHotels = relaxResult.candidates;

        const relaxationBanner = describeRelaxation(relaxResult.appliedLevel);
        const usedDifferentDestination =
            relaxResult.usedDestinationId !== request.destinationId;
        let destinationFallbackInfo: HotelSearchQueueResponse['destinationFallback'] = null;
        if (usedDifferentDestination && dbHotels.length > 0) {
            const [origName, usedName] = await Promise.all([
                hotelSearchRepository.getDestinationName(request.destinationId),
                hotelSearchRepository.getDestinationName(relaxResult.usedDestinationId),
            ]);
            destinationFallbackInfo = {
                originalDestinationId: request.destinationId,
                originalDestinationName: origName ?? (request.destinationName ?? ''),
                usedDestinationId: relaxResult.usedDestinationId,
                usedDestinationName: usedName ?? '',
                bannerMessage: describeDestinationFallback(
                    dbHotels.length,
                    origName ?? (request.destinationName ?? 'the requested area'),
                    usedName ?? 'a wider area',
                ),
            };
        }

        if (
            relaxResult.appliedLevel !== 'exact' &&
            relaxResult.appliedLevel !== 'star_pm1'
        ) {
            await logAuditEvent({
                action: 'search_relaxation_applied',
                entity: 'booking_request',
                entityId: requestId,
                details: {
                    appliedLevel: relaxResult.appliedLevel,
                    fallbackDestinationId: usedDifferentDestination
                        ? relaxResult.usedDestinationId
                        : null,
                    candidateCount: dbHotels.length,
                    manualRequestOnly: relaxResult.manualRequestOnly,
                    flow: 'auto-offer',
                },
            });
        }

        if (dbHotels.length === 0) {
            logger.warn(
                { requestId, destinationId: request.destinationId },
                'Auto-offer: no hotels at any relaxation level or fallback destination',
            );
            return {
                requestId,
                totalCandidates: 0,
                jobsQueued: 0,
                message: 'No hotels available for this request — please submit a manual request.',
                sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
                statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
                relaxation: null,
                destinationFallback: null,
                manualRequestOnly: true,
            };
        }

        // Sort: primary star matches first, then alternatives.
        // After relaxation, "primary" is whichever stars match the requested rating
        // exactly; if the requested star rating was dropped, ordering by current
        // DB order is fine.
        const primaryHotelCodes = new Set(
            requestedStarRating == null
                ? dbHotels.map((h) => h.hotelCode)
                : dbHotels
                      .filter((h) => {
                          const s = h.starRating ? Number(h.starRating) : null;
                          return s !== null && Math.abs(requestedStarRating - s) < 0.5;
                      })
                      .map((h) => h.hotelCode),
        );
        const sortedHotels = [
            ...dbHotels.filter((h) => primaryHotelCodes.has(h.hotelCode)),
            ...dbHotels.filter((h) => !primaryHotelCodes.has(h.hotelCode)),
        ];

        // Clean up old probe jobs from previous searches for this request
        await hotelProbeJobRepository.deleteBySearchRequest(requestId);

        const roomTypeTargets = buildRoomTypeTargets((request as any).rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * PROBE_MULTIPLIER;
        let jobsQueued = 0;

        // Drop probe-time mealType filter when relaxation reached meal_dropped+
        const RELAXED_PAST_MEAL_AUTO: ReadonlySet<RelaxationLevel> = new Set<RelaxationLevel>([
            'meal_dropped',
            'location_dropped',
            'facilities_dropped',
        ]);
        const probeMealType = RELAXED_PAST_MEAL_AUTO.has(relaxResult.appliedLevel)
            ? undefined
            : params.mealType;

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
                mealType: probeMealType,
                markupPercent,
                expandedRooms,
                dominantRoomType,
                roomTypeTargets,
            });
            jobsQueued++;
        }

        logger.info(
            {
                requestId,
                totalCandidates: dbHotels.length,
                jobsQueued,
                appliedLevel: relaxResult.appliedLevel,
                usedDestinationId: relaxResult.usedDestinationId,
            },
            'Auto-offer probe jobs queued',
        );

        return {
            requestId,
            totalCandidates: dbHotels.length,
            jobsQueued,
            message: `${jobsQueued} hotel probe jobs queued for auto-offer generation.`,
            sseEndpoint: `/api/v1/requests/${requestId}/hotel-search/events`,
            statusEndpoint: `/api/v1/requests/${requestId}/hotel-search/status`,
            relaxation: relaxationBanner
                ? { level: relaxResult.appliedLevel, bannerMessage: relaxationBanner }
                : null,
            destinationFallback: destinationFallbackInfo,
            manualRequestOnly: false,
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
