

import { randomUUID } from 'crypto';
import requestRepository from '../repositories/request.repository';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import wbeClientService from './wbe.client.service';
import { publishHotelProbeJob } from '../queue/hotelProbe.publisher';
import logger from '../utils/logger';
import { normalisePricePerRoomPerNight } from '../utils/pricing';
import { getSupplierMaxRooms, isGroupAllowed, getCappedMax, getSupplierPriority, SUPPLIER_PRIORITY_RANK } from '../config/supplierLimits';
import { loadDefaultMarkupPercent, getDefaultMarkupPercentSync } from './settings.service';
import {
    PROBE_BATCH_SIZE,
    PROBE_MULTIPLIER,
    PROBE_WAIT_SECONDS,
    ROOM_TYPE_ADULTS,
    SEARCH_BATCH_SIZE,
    MAX_SEARCH_BATCHES,
    TARGET_VIABLE_HOTELS,
} from '../config/probeConfig';
import type { ExpandedRoom, RoomTypeProbeTarget } from '../queue/hotelProbeJob.types';
import { countTotalRooms, hasNewDoubleBreakdown, normalizeRoomCounts } from '../utils/roomUtils';
import {
    RELAXATION_LADDER,
    buildStarList,
    buildExpandingRingLadder,
    describeRelaxation,
    describeDestinationFallback,
    describeAlternativeReason,
    type RelaxationLevel,
} from './searchRelaxation';
import { logAuditEvent } from '../utils/audit';
import { BookingRequestStatus } from '@prisma/client';
import { broadcast } from './sseManager';
import config from '../config';

/**
 * Resolve the nationality code for a WBE search.
 *
 * Precedence:
 *   1. Caller-supplied param override (search-time customisation)
 *   2. BookingRequest.nationalityCode set by staff on the Create Request form
 *   3. Legacy 'HU' fallback — ONLY for requests created before
 *      `config.nationality.fallbackCutoffDate`. New requests must have a
 *      nationality (the Zod schema rejects missing values at the API
 *      boundary), so the only path that reaches this fallback today is a
 *      webhook-created row (Wix / WordPress) that didn't pass nationality
 *      in its payload.
 *
 * Post-cutoff with no nationality: throws a structured 400 error. WBE
 * would reject the search anyway; failing fast with a clear message is
 * better than a cryptic upstream failure. The fix is to populate
 * `nationalityCode` on the request — staff via Edit Request, or by
 * fixing the upstream webhook payload to carry the field.
 */
function resolveNationalityCode(
    paramOverride: string | null | undefined,
    request: { nationalityCode: string | null; createdAt: Date; id: string },
): string {
    if (paramOverride) return paramOverride;
    if (request.nationalityCode) return request.nationalityCode;

    const cutoff = new Date(config.nationality.fallbackCutoffDate);
    if (request.createdAt < cutoff) {
        logger.warn(
            { requestId: request.id, createdAt: request.createdAt.toISOString() },
            "Legacy request without nationalityCode — falling back to 'HU' (pre-cutoff grandfather)",
        );
        return 'HU';
    }

    logger.error(
        { requestId: request.id, createdAt: request.createdAt.toISOString() },
        'Cannot search: request has no nationalityCode and was created after the fallback cutoff',
    );
    throw {
        status: 400,
        message:
            'This request has no nationality set. Open the request, pick a nationality on the Trip Details panel, then re-run the search.',
        code: 'NATIONALITY_REQUIRED',
    };
}

/**
 * Resolve the meal-type filter for a WBE probe.
 *
 * Precedence:
 *   1. Caller-supplied override (`params.mealType`) — this is what the FE
 *      normally passes on the search API call, mapped from the request's
 *      stored `breakfastPreference`.
 *   2. Server-side fallback to `request.breakfastPreference` — a safety
 *      net for the case where the FE (or an alternate caller like Postman
 *      / a script / an untested new call site) forgets to pass mealType.
 *      When the fallback fires, we log a warning so a future FE regression
 *      surfaces in monitoring instead of silently selling RO rates for BB
 *      requests. That failure mode caused request #522's Savoy Crest offer
 *      to be built on RO rates instead of BB (2026-07-14 04:30 UTC window
 *      — see incident notes).
 *   3. `undefined` if the request itself has no breakfast preference set.
 *      With `undefined`, the worker's meal filter is deliberately dropped
 *      (search returns all meal plans). This preserves the existing
 *      "relaxation past meal_dropped" behaviour and the very rare case
 *      where a request row has no preference at all.
 *
 * Callers should read this once and pass the result down. Do NOT re-derive
 * inside a hot loop.
 */
function resolveMealType(
    paramOverride: string | null | undefined,
    request: { id: string; breakfastPreference?: string | null },
): string | undefined {
    if (paramOverride) return paramOverride;

    const stored = request.breakfastPreference;
    if (stored) {
        logger.warn(
            { requestId: request.id, breakfastPreference: stored },
            'Meal-type absent from search params — falling back to request.breakfastPreference. Check the FE is passing mealType on the /hotel-search call.',
        );
        return stored;
    }

    return undefined;
}

/**
 * Read the requested star categories from a BookingRequest row.
 *
 * Strategy: prefer the new multi-select `starRatings` array. If it's
 * empty (legacy row, or "any rating" intent), fall back to the legacy
 * single `starRating` field — wrapping it in a one-element array so
 * the rest of the pipeline only ever sees `number[]`.
 *
 * Returns an empty array when neither is set — `buildStarList` treats
 * that as "no star filter" at every relaxation level.
 */
function resolveRequestedStars(request: any): number[] {
    const arr = request?.starRatings;
    if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n));
    }
    const single = request?.starRating;
    if (single != null) {
        const n = Number(single);
        if (Number.isFinite(n)) return [n];
    }
    return [];
}

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
    /** Net (buying) price per room per night from the supplier. */
    pricePerRoomPerNight: number;
    /**
     * Room type this split covers (single, twin, triple, quadruple,
     * standardDoubleBeds, quadruple__sub_double, etc.). Populated by
     * the probe worker's per-type allocation step. Optional for
     * backwards-compat with older cached rows.
     */
    roomType?: string;
    /**
     * Customer-facing sell price per room per night for this specific
     * room type. Computed by the worker as:
     *   sell = psych(ceil(net × (1 + markup% / 100)))
     * Same formula as the hotel-level `sellingPricePerRoomPerNight`,
     * applied per row. Optional because legacy cached rows may not have
     * this field.
     */
    sellPricePerRoomPerNight?: number;
    /**
     * Full calculation trail for the "how was this calculated" staff
     * panel. Exposes every intermediate value so nothing is opaque.
     * Optional for the same backwards-compat reason.
     */
    sellCalculation?: {
        buyingPrice: number;      // net input (same as pricePerRoomPerNight)
        markupPercent: number;    // effective markup %
        raw: number;              // net × (1 + markup/100), unrounded
        ceil: number;             // Math.ceil(raw)
        psychAdjustment: number;  // -2, -1, or 0
        sellPrice: number;        // final ceil + psychAdjustment
    };
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
    /**
     * WBE "Important Information" (check-in/out times, parking, etc.) from the
     * supplier's OptionDetailsV2 DayPrices.EssentialInfo. Raw HTML string — the
     * FE should sanitise/strip before rendering. Null when the supplier gave none.
     */
    essentialInfo?: string | null;
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

    /**
     * Pagination context — set when the search was issued and the destination
     * has more candidate hotels than the first batch could cover. The async
     * orchestrator (offerGeneration.service.ts for auto-offers, or the
     * post-probe watcher for manual searches) uses this to call
     * `enqueueAdditionalCandidates()` and chain more probe batches until
     * TARGET_VIABLE_HOTELS is reached or the destination is exhausted.
     *
     * Only present when paginated search is active (i.e. when the destination
     * has more hotels than SEARCH_BATCH_SIZE).
     */
    paginationContext?: {
        /** Destination ID used for the search (may differ from request.destinationId if relaxation widened). */
        usedDestinationId: number;
        /** Star ratings filter actually applied (may be ±1 from request if relaxation widened). */
        starRatings: number[];
        /** Total hotels in master.hotels matching the destination + star filter (used to detect "exhausted"). */
        totalCandidates: number;
        /** Next batch starts at this offset (= hotels probed so far at this relaxation level). */
        nextOffset: number;
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
        // For small requests (1-2 rooms), probe exactly the requested count
        // so WBE returns options matching the actual room count.
        // For 3+ rooms, apply the multiplier to probe deeper.
        const probeLimit = n < PROBE_BATCH_SIZE ? n : n * PROBE_MULTIPLIER;
        targets.push({
            roomType: type,
            requested: n,
            probeLimit,
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
    // Priority-first, cheapest-first tie-break — see hotelProbe.worker.ts
    // buildSupplierSplit for the full rationale. Must stay in sync with
    // that copy: the two functions differ in call-site details but share
    // the same allocation rule.
    const sorted = [...midBandOptions].sort((a, b) => {
        const rankA = SUPPLIER_PRIORITY_RANK[getSupplierPriority(a.supplierCode)];
        const rankB = SUPPLIER_PRIORITY_RANK[getSupplierPriority(b.supplierCode)];
        if (rankA !== rankB) return rankA - rankB;         // higher priority first
        return a.pricePerRoomPerNight - b.pricePerRoomPerNight; // then cheapest first
    });
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
        /**
         * Multi-select star categories from the request (one entry per
         * ticked box on the form). Empty array means "any rating".
         * Each entry is widened independently by the relaxation ladder
         * (±1, ±2, any) and unioned via `buildStarList`.
         */
        requestedStarRatings: number[];
        facilityIds?: number[];
        /**
         * For the ORIGINAL destination only, skip ladder levels < this index.
         * Used by the post-probe relaxation watcher to advance one level at a
         * time when prior probe results came back empty. Fallback destinations
         * (parent / country / nearby) always start the ladder at 0.
         * Defaults to 0 (full ladder).
         */
        startLevelIndex?: number;
        /**
         * When true, the repository orders youth-friendly hotels first so
         * pagination probes them before chain hotels. Driven by the
         * request's groupType (youth / school).
         */
        prioritiseYouthFriendly?: boolean;
    }): Promise<{
        candidates: Awaited<ReturnType<typeof hotelSearchRepository.getHotelCodesByDestination>>;
        appliedLevel: RelaxationLevel;
        usedDestinationId: number;
        manualRequestOnly: boolean;
        /** Star rating filter actually used in the winning attempt — needed for pagination follow-up batches. */
        appliedStars: number[];
    }> {
        const startIdx = Math.max(0, Math.min(opts.startLevelIndex ?? 0, RELAXATION_LADDER.length - 1));

        const tryAtDestination = async (destId: number, fromIndex: number) => {
            for (let i = fromIndex; i < RELAXATION_LADDER.length; i++) {
                const config = RELAXATION_LADDER[i]!;
                const stars = buildStarList(opts.requestedStarRatings, config.starWindow);
                let dbHotels = await hotelSearchRepository.getHotelCodesByDestination(
                    destId,
                    stars,
                    undefined,
                    undefined,
                    { prioritiseYouthFriendly: opts.prioritiseYouthFriendly === true },
                );
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
                    return { candidates: dbHotels, level: config.level, stars };
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
                appliedStars: direct.stars,
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
                    appliedStars: result.stars,
                };
            }
        }

        // 3. Nothing worked anywhere — surface manualRequestOnly.
        return {
            candidates: [],
            appliedLevel: 'facilities_dropped',
            usedDestinationId: opts.destinationId,
            manualRequestOnly: true,
            appliedStars: [],
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
        initialPaginationContext: NonNullable<HotelSearchQueueResponse['paginationContext']>,
    ): Promise<void> {
        // Two-level state machine:
        //   Outer loop: relaxation ladder (current level → next level → …)
        //   Inner loop: pagination batches AT the current level (offset 0 → 200 → 400 → …)
        //
        // The inner loop is new for Option 1 pagination (N=50). It chains
        // additional 200-hotel batches at the same destination + star filter
        // until either TARGET_VIABLE_HOTELS viable hotels accumulate, the
        // destination is exhausted at this level, or MAX_SEARCH_BATCHES is hit.
        //
        // When the inner loop ends without enough hotels, the outer loop
        // advances the relaxation ladder (existing behaviour) — UNLESS we
        // already have at least one viable hotel, in which case we broadcast
        // searchSettled (don't blow away usable results by widening criteria).
        let currentLevel: RelaxationLevel = startLevel;
        let paginationContext = initialPaginationContext;

        // Load the request's multi-select star categories once.
        const requestForStars = await requestRepository.findById(requestId);
        const requestedStarRatings = resolveRequestedStars(requestForStars);

        // Build the expanding ring of star bands to walk after the exact
        // tier. Per Oliver's brief: the search probes hotels closest to
        // the requested categor(ies) first, then expands outward in this
        // priority order (per centre):
        //   tier 0: requested star                      (exact)
        //   tier 1: +0.5                                (closest UP)
        //   tier 2: +1.0                                (one full step UP)
        //   tier 3: -0.5                                (closest DOWN)
        //   tier 4: -1.0                                (one full step DOWN)
        // Capped at ±1 — never widens beyond that. The watcher stops the
        // moment TARGET_VIABLE_HOTELS is met OR every ring tier has been
        // probed without reaching target (then it settles with whatever
        // viable hotels it found).
        const ringTiers = buildExpandingRingLadder(requestedStarRatings);
        // The initial search already probed tier 0 (the exact band), so the
        // watcher starts the outer loop at tier 1 (first widening).
        let ringIndex = 0;
        // Outer loop iterations = number of ring tiers. Each iteration is
        // one "rung climb" (paginate-probe-evaluate at the current tier).
        // We always need at least 1 iteration so the inner loop runs even
        // when ringTiers has just the exact tier (no widening needed).
        const MAX_ITERATIONS = Math.max(1, ringTiers.length);

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            // ── Inner loop: paginate within the CURRENT relaxation level ──
            let paginationStopReason:
                | 'target_met'
                | 'destination_exhausted'
                | 'max_batches_reached'
                | 'level_zero_results'
                | 'timeout'
                | 'unknown' = 'unknown';

            // The first iteration of this inner loop waits for the batch that
            // was queued by the search (or by a prior ladder-advance). Each
            // additional iteration waits for a batch we just queued ourselves.
            let probeResult = await this.waitForProbeJobsToTerminate(requestId);

            // Pagination inner loop: keep fetching batches at this level until
            // we hit a terminal condition.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                if (probeResult.timedOut) {
                    paginationStopReason = 'timeout';
                    break;
                }
                if (probeResult.totalCount === 0) {
                    paginationStopReason = 'level_zero_results';
                    break;
                }

                const viableCount = await hotelProbeJobRepository.countViable(requestId);

                // Target met — show results.
                if (viableCount >= TARGET_VIABLE_HOTELS) {
                    paginationStopReason = 'target_met';
                    break;
                }

                // Try to queue the next batch at this level.
                const nextBatch = await this.enqueueAdditionalCandidates(
                    requestId,
                    paginationContext,
                    params,
                );

                // Terminate the inner loop only when the destination is
                // genuinely exhausted at this tier or the safety ceiling
                // is reached. A `queued` decision with `queuedCount === 0`
                // means all hotels in this batch were duplicates of
                // previously-probed codes (common after widening to a
                // wider ring tier — the inner hotels are all already
                // probed). In that case we KEEP paginating: advance the
                // offset and try the next batch.
                if (nextBatch.decision !== 'queued') {
                    paginationStopReason =
                        nextBatch.decision === 'max_batches_reached'
                            ? 'max_batches_reached'
                            : 'destination_exhausted';
                    break;
                }

                logger.info(
                    {
                        requestId,
                        level: currentLevel,
                        viableSoFar: viableCount,
                        target: TARGET_VIABLE_HOTELS,
                        nextOffset: nextBatch.nextOffset,
                        queuedThisBatch: nextBatch.queuedCount,
                    },
                    nextBatch.queuedCount === 0
                        ? 'Post-probe pagination: batch had only duplicates, advancing offset'
                        : 'Post-probe pagination: queued next batch at same level',
                );

                paginationContext = {
                    ...paginationContext,
                    nextOffset: nextBatch.nextOffset,
                };

                // If the previous batch queued no new hotels, there's nothing
                // to wait for — loop straight to the next batch without
                // calling waitForProbeJobsToTerminate (which would block on
                // already-terminal jobs but return immediately anyway —
                // skipping the wait keeps the log noise down).
                if (nextBatch.queuedCount === 0) {
                    continue;
                }
                probeResult = await this.waitForProbeJobsToTerminate(requestId);
            }

            // ── End of inner loop. Decide: settle, exit, or advance ladder. ──
            const finalViableCount = await hotelProbeJobRepository.countViable(requestId);

            if (paginationStopReason === 'timeout') {
                logger.warn(
                    { requestId, level: currentLevel },
                    'Post-probe relaxation: timed out waiting for probes — watcher exiting',
                );
                return;
            }

            if (paginationStopReason === 'level_zero_results') {
                logger.info(
                    { requestId, level: currentLevel },
                    'Post-probe relaxation: no probes found for this request — watcher exiting',
                );
                return;
            }

            // Settle when:
            //  (a) target met (≥ TARGET_VIABLE_HOTELS viable hotels), OR
            //  (b) we have at least one viable hotel AND the expanding-ring
            //      ladder is exhausted (every star tier within ±1 of every
            //      requested centre has been probed).
            //
            // Otherwise, the watcher climbs the next ring tier. Previous
            // behaviour was "settle on ANY viable hotel > 0", which made
            // the search stop at the strict band even when the destination
            // had many more hotels at adjacent stars. Oliver's directive:
            // "more options is better, widen aggressively — center first,
            //  then ±0.5 up, then ±1 up, then ±0.5 down, then ±1 down".
            const ringHasMoreTiers = ringIndex < ringTiers.length - 1;
            const targetMet = finalViableCount >= TARGET_VIABLE_HOTELS;
            const shouldSettle =
                targetMet ||
                (finalViableCount > 0 && !ringHasMoreTiers);

            if (shouldSettle) {
                logger.info(
                    {
                        requestId,
                        level: currentLevel,
                        ringIndex,
                        ringTiersTotal: ringTiers.length,
                        viableCount: finalViableCount,
                        target: TARGET_VIABLE_HOTELS,
                        stopReason: paginationStopReason,
                        offsetReached: paginationContext.nextOffset,
                        targetMet,
                    },
                    'Post-probe relaxation: settling search — target met or ring exhausted',
                );
                try {
                    await requestRepository.setSearchPaginationCursor(requestId, paginationContext);
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(settled) failed');
                }
                try {
                    await requestRepository.updateSearchPhase(requestId, 'settled');
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(settled) failed');
                }
                broadcast(requestId, 'searchSettled', {
                    requestId,
                    finalLevel: currentLevel,
                    successCount: finalViableCount,
                    totalCount: probeResult.totalCount,
                });
                return;
            }

            // Zero viable + ring fully walked → ladder truly exhausted. This
            // is the "never say no" dead end — flag for manual handling.
            if (finalViableCount === 0 && !ringHasMoreTiers) {
                logger.info(
                    { requestId, level: currentLevel, ringIndex },
                    'Post-probe relaxation: ring exhausted with zero viable — flagging as needs_manual_handling',
                );
                await requestRepository.updateStatus(
                    requestId,
                    BookingRequestStatus.needs_manual_handling,
                );
                try {
                    await requestRepository.updateSearchPhase(requestId, 'exhausted');
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(exhausted) failed');
                }
                try {
                    await requestRepository.setSearchPaginationCursor(requestId, null);
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(null) on exhausted failed');
                }
                broadcast(requestId, 'searchExhausted', {
                    requestId,
                    finalLevel: currentLevel,
                });
                return;
            }

            // ── Additive ring advance ───────────────────────────────────
            // Below target AND the ring has more tiers → climb to the next
            // tier (one step further from the requested centre). The next
            // tier's star list is the CUMULATIVE union from tier 0 to
            // tier (ringIndex+1). enqueueAdditionalCandidates de-dups by
            // hotel_code, so already-probed hotels at narrower bands stay
            // intact — only NEW hotels at the newly-included stars get
            // probed. No wasted WBE calls.
            ringIndex += 1;
            const nextStarList = ringTiers[ringIndex] ?? [];
            const nextTotalCandidates = await hotelSearchRepository.countHotelsByDestination(
                paginationContext.usedDestinationId,
                nextStarList,
            );

            // Map ring index back to a banner-friendly level for the FE.
            // ringIndex 1-2 are "up" steps (showing slightly better hotels),
            // 3-4 are "down" steps. We keep using the existing star_pm1 /
            // star_pm2 level codes so the existing banner i18n still works.
            const nextLevel: RelaxationLevel = ringIndex <= 2 ? 'star_pm1' : 'star_pm2';
            const previousLevel = currentLevel;
            currentLevel = nextLevel;
            paginationContext = {
                usedDestinationId: paginationContext.usedDestinationId,
                starRatings: nextStarList,
                totalCandidates: nextTotalCandidates,
                nextOffset: 0,
            };

            await logAuditEvent({
                action: 'search_post_probe_relaxation',
                entity: 'booking_request',
                entityId: requestId,
                details: {
                    fromLevel: previousLevel,
                    toLevel: nextLevel,
                    ringIndex,
                    newStarList: nextStarList,
                    iteration: iter + 1,
                },
            });

            broadcast(requestId, 'searchRelaxed', {
                requestId,
                fromLevel: previousLevel,
                toLevel: nextLevel,
                iteration: iter + 1,
            });

            logger.info(
                {
                    requestId,
                    fromLevel: previousLevel,
                    toLevel: nextLevel,
                    ringIndex,
                    newStarList: nextStarList,
                    newTotalCandidates: nextTotalCandidates,
                    existingViable: finalViableCount,
                },
                'Post-probe relaxation: widened star ring — appending more probes',
            );
            // Inner loop will paginate the wider ring on the next iteration.
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
        const requestedStarRatings = resolveRequestedStars(request);
        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        // Was: `params.nationalityCode ?? request.nationalityCode ?? 'HU'`.
        // The silent 'HU' default was the root cause of "prices don't match
        // Hub" — see commit notes 2026-06-26. New code uses a cutoff-date
        // guard so only legacy rows still hit the 'HU' branch.
        const nationalityCode = resolveNationalityCode(params.nationalityCode, request);
        const includeAlternativeStars = params.includeAlternativeStars !== false;
        const waitSeconds = params.waitSeconds ?? PROBE_WAIT_SECONDS;
        // Read the live default markup from Settings (cached 30s). The hot
        // path downstream uses `getDefaultMarkupPercentSync()` which now
        // returns the same value. Per-supplier overrides not yet implemented.
        const markupPercent = await loadDefaultMarkupPercent();

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
        const groupTypeForPriority = ((request as any).groupType as string | null | undefined) ?? null;
        const prioritiseYouthFriendly = groupTypeForPriority === 'youth' || groupTypeForPriority === 'school';
        const relaxResult = await this.findCandidatesWithRelaxation({
            destinationId,
            requestedStarRatings,
            facilityIds: params.facilityIds,
            startLevelIndex: internalOpts?.startLevelIndex,
            prioritiseYouthFriendly,
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
            try {
                await requestRepository.updateSearchPhase(requestId, 'exhausted');
            } catch (err: any) {
                logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(exhausted) failed');
            }
            try {
                await requestRepository.setSearchPaginationCursor(requestId, null);
            } catch (err: any) {
                logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(null) on exhausted failed');
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

        // Reset search phase to 'in_progress' for the polling FE's terminal
        // detection. Best-effort — a missed phase update should not abort the
        // search itself, so we swallow + log any error here.
        try {
            await requestRepository.updateSearchPhase(requestId, 'in_progress');
        } catch (err: any) {
            logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(in_progress) failed — search continues');
        }
        // Clear any stale pagination cursor from a previous search on this
        // request — a fresh search means a fresh cursor, persisted later
        // by the watcher.
        try {
            await requestRepository.setSearchPaginationCursor(requestId, null);
        } catch (err: any) {
            logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(null) failed — search continues');
        }

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
        // Resolve meal type via the helper so a missing params.mealType
        // (FE regression, script/Postman call, etc.) falls back to the
        // request's stored breakfastPreference instead of silently
        // returning ALL meal plans (which caused the #522 incident).
        const resolvedMealType = resolveMealType(params.mealType, request as any);
        const probeMealType = RELAXED_PAST_MEAL.has(relaxResult.appliedLevel)
            ? undefined
            : resolvedMealType;

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

        // Pre-compute pagination context once and reuse for both the watcher
        // (so it can iterate additional batches at this destination/level
        // BEFORE advancing the relaxation ladder) and the response payload.
        const totalCandidatesAtLevel = await hotelSearchRepository.countHotelsByDestination(
            relaxResult.usedDestinationId,
            relaxResult.appliedStars,
        );
        const initialPaginationContext = {
            usedDestinationId: relaxResult.usedDestinationId,
            starRatings: relaxResult.appliedStars,
            totalCandidates: totalCandidatesAtLevel,
            nextOffset: dbHotels.length,
        };

        // Spawn the post-probe relaxation watcher (fire and forget). Skipped
        // when this call is itself a recursive re-trigger from the watcher
        // (otherwise we'd nest watchers infinitely).
        if (!internalOpts?.suppressWatcher) {
            setImmediate(() => {
                this.runPostProbeRelaxation(
                    requestId,
                    params,
                    relaxResult.appliedLevel,
                    initialPaginationContext,
                ).catch((err) => {
                    logger.error(
                        { err: err?.message, requestId },
                        'Post-probe relaxation watcher crashed',
                    );
                });
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
            paginationContext: initialPaginationContext,
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
        const requestedStarRatings = resolveRequestedStars(request);
        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        // Was: `params.nationalityCode ?? request.nationalityCode ?? 'HU'`.
        // The silent 'HU' default was the root cause of "prices don't match
        // Hub" — see commit notes 2026-06-26. New code uses a cutoff-date
        // guard so only legacy rows still hit the 'HU' branch.
        const nationalityCode = resolveNationalityCode(params.nationalityCode, request);
        const waitSeconds = params.waitSeconds ?? PROBE_WAIT_SECONDS;
        // Read the live default markup from Settings (cached 30s).
        const markupPercent = await loadDefaultMarkupPercent();

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

        const altGroupType = ((request as any).groupType as string | null | undefined) ?? null;
        const altPrioritiseYouthFriendly = altGroupType === 'youth' || altGroupType === 'school';
        const collectAtDestination = async (
            destId: number,
            isFallback: boolean,
            fromIndex: number,
        ) => {
            for (let i = fromIndex; i < RELAXATION_LADDER.length; i++) {
                const config = RELAXATION_LADDER[i]!;
                const stars = buildStarList(requestedStarRatings, config.starWindow);
                let dbHotels = await hotelSearchRepository.getHotelCodesByDestination(
                    destId,
                    stars,
                    undefined,
                    undefined,
                    { prioritiseYouthFriendly: altPrioritiseYouthFriendly },
                );

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
        // Was: `params.nationalityCode ?? request.nationalityCode ?? 'HU'`.
        // The silent 'HU' default was the root cause of "prices don't match
        // Hub" — see commit notes 2026-06-26. New code uses a cutoff-date
        // guard so only legacy rows still hit the 'HU' branch.
        const nationalityCode = resolveNationalityCode(params.nationalityCode, request);
        const includeAlternativeStars = params.includeAlternativeStars !== false;
        const waitSeconds = params.waitSeconds ?? PROBE_WAIT_SECONDS;
        const markupPercent = params.markupPercent ?? (await loadDefaultMarkupPercent());

        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);

        const dominantRoomType = getDominantRoomType((request as any).rooms);
        const expandedRooms = expandRequestRooms((request as any).rooms);

        const requestedStarRatings = resolveRequestedStars(request);
        void includeAlternativeStars; // superseded by the explicit relaxation ladder

        // ── "Never say no" candidate selection (auto-offer flow) ──────────
        const autoGroupType = ((request as any).groupType as string | null | undefined) ?? null;
        const autoPrioritiseYouthFriendly = autoGroupType === 'youth' || autoGroupType === 'school';
        const relaxResult = await this.findCandidatesWithRelaxation({
            destinationId: request.destinationId,
            requestedStarRatings,
            facilityIds: params.facilityIds,
            prioritiseYouthFriendly: autoPrioritiseYouthFriendly,
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
            try {
                await requestRepository.updateSearchPhase(requestId, 'exhausted');
            } catch (err: any) {
                logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(exhausted) failed');
            }
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
        // After relaxation, "primary" is whichever stars match ANY of the
        // requested categories within ±0.5. When no stars were requested
        // (or the filter was relaxed to "any"), every hotel counts as
        // primary so the original DB order is preserved.
        const primaryHotelCodes = new Set(
            requestedStarRatings.length === 0
                ? dbHotels.map((h) => h.hotelCode)
                : dbHotels
                      .filter((h) => {
                          const s = h.starRating ? Number(h.starRating) : null;
                          if (s === null) return false;
                          return requestedStarRatings.some((req) => Math.abs(req - s) < 0.5);
                      })
                      .map((h) => h.hotelCode),
        );
        const sortedHotels = [
            ...dbHotels.filter((h) => primaryHotelCodes.has(h.hotelCode)),
            ...dbHotels.filter((h) => !primaryHotelCodes.has(h.hotelCode)),
        ];

        // Clean up old probe jobs from previous searches for this request
        await hotelProbeJobRepository.deleteBySearchRequest(requestId);

        // Reset search phase to 'in_progress' for the polling FE's terminal
        // detection. Best-effort.
        try {
            await requestRepository.updateSearchPhase(requestId, 'in_progress');
        } catch (err: any) {
            logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(in_progress) failed — auto-offer continues');
        }

        const roomTypeTargets = buildRoomTypeTargets((request as any).rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * PROBE_MULTIPLIER;
        let jobsQueued = 0;

        // Drop probe-time mealType filter when relaxation reached meal_dropped+
        const RELAXED_PAST_MEAL_AUTO: ReadonlySet<RelaxationLevel> = new Set<RelaxationLevel>([
            'meal_dropped',
            'location_dropped',
            'facilities_dropped',
        ]);
        // Same server-side meal-type fallback as searchForRequest — protects
        // the auto-offer webhook path from silently dropping the meal filter.
        const resolvedMealTypeAuto = resolveMealType(params.mealType, request as any);
        const probeMealType = RELAXED_PAST_MEAL_AUTO.has(relaxResult.appliedLevel)
            ? undefined
            : resolvedMealTypeAuto;

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

        // Pagination context — total candidates at this relaxation level so the
        // orchestrator knows when the destination is exhausted. The orchestrator
        // (offerGeneration.service.ts) will call enqueueAdditionalCandidates()
        // with this context to chain more batches until TARGET_VIABLE_HOTELS is
        // reached or the destination is exhausted.
        const totalCandidatesAtLevel = await hotelSearchRepository.countHotelsByDestination(
            relaxResult.usedDestinationId,
            relaxResult.appliedStars,
        );

        logger.info(
            {
                requestId,
                firstBatchQueued: jobsQueued,
                totalCandidatesAtLevel,
                appliedLevel: relaxResult.appliedLevel,
                usedDestinationId: relaxResult.usedDestinationId,
                appliedStars: relaxResult.appliedStars,
            },
            'Auto-offer first batch queued — pagination context recorded',
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
            paginationContext: {
                usedDestinationId: relaxResult.usedDestinationId,
                starRatings: relaxResult.appliedStars,
                totalCandidates: totalCandidatesAtLevel,
                nextOffset: dbHotels.length,
            },
        };
    }

    /**
     * Queue the NEXT batch of probe jobs for an in-progress search.
     *
     * Used by the auto-offer orchestrator to chain additional batches when the
     * first 200 hotels don't yield enough viable results (target N = 50). Does
     * NOT delete existing jobs — strictly appends.
     *
     * `paginationContext` comes from `generateAutoOffer()`'s return value. The
     * orchestrator passes it back here and advances `nextOffset` each round.
     */
    async enqueueAdditionalCandidates(
        requestId: string,
        paginationContext: NonNullable<HotelSearchQueueResponse['paginationContext']>,
        params: { mealType?: string; markupPercent?: number; currencyCode?: string; nationalityCode?: string; waitSeconds?: number } = {},
        options: { bypassCeiling?: boolean } = {},
    ): Promise<{
        decision: 'queued' | 'destination_exhausted' | 'max_batches_reached';
        queuedCount: number;
        queuedHotelCodes: string[];
        nextOffset: number;
    }> {
        // Hard ceiling — never exceed SEARCH_BATCH_SIZE * MAX_SEARCH_BATCHES
        // per relaxation level. The "Search More" feature explicitly opts out
        // via `bypassCeiling: true` because it's user-driven (one click = one
        // batch) and the user is in control of how many batches to probe.
        // The auto-offer flow leaves the ceiling in place.
        if (!options.bypassCeiling && paginationContext.nextOffset >= SEARCH_BATCH_SIZE * MAX_SEARCH_BATCHES) {
            return {
                decision: 'max_batches_reached',
                queuedCount: 0,
                queuedHotelCodes: [],
                nextOffset: paginationContext.nextOffset,
            };
        }
        // Whole destination already exhausted at this level.
        if (paginationContext.nextOffset >= paginationContext.totalCandidates) {
            return {
                decision: 'destination_exhausted',
                queuedCount: 0,
                queuedHotelCodes: [],
                nextOffset: paginationContext.nextOffset,
            };
        }

        const request = await requestRepository.findById(requestId);
        if (!request) {
            throw { status: 404, message: 'Booking request not found', code: 'NOT_FOUND' };
        }

        const totalRooms = countTotalRooms(request.rooms);
        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        // Was: `params.nationalityCode ?? request.nationalityCode ?? 'HU'`.
        // The silent 'HU' default was the root cause of "prices don't match
        // Hub" — see commit notes 2026-06-26. New code uses a cutoff-date
        // guard so only legacy rows still hit the 'HU' branch.
        const nationalityCode = resolveNationalityCode(params.nationalityCode, request);
        const waitSeconds = params.waitSeconds ?? PROBE_WAIT_SECONDS;
        const markupPercent = params.markupPercent ?? (await loadDefaultMarkupPercent());
        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);
        const dominantRoomType = getDominantRoomType((request as any).rooms);
        const expandedRooms = expandRequestRooms((request as any).rooms);
        const roomTypeTargets = buildRoomTypeTargets((request as any).rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * PROBE_MULTIPLIER;

        // Fetch the next page of candidates at the same destination + star filter as the first batch.
        // Pass through the same youth-friendly prioritisation flag the first batch used so subsequent
        // batches keep the same ordering and don't skip youth-friendly inventory.
        const batchGroupType = ((request as any).groupType as string | null | undefined) ?? null;
        const batchPrioritiseYouthFriendly = batchGroupType === 'youth' || batchGroupType === 'school';
        const batch = await hotelSearchRepository.getHotelCodesByDestination(
            paginationContext.usedDestinationId,
            paginationContext.starRatings,
            SEARCH_BATCH_SIZE,
            paginationContext.nextOffset,
            { prioritiseYouthFriendly: batchPrioritiseYouthFriendly },
        );
        if (batch.length === 0) {
            return {
                decision: 'destination_exhausted',
                queuedCount: 0,
                queuedHotelCodes: [],
                nextOffset: paginationContext.nextOffset,
            };
        }

        // Defensive: skip any hotel codes already probed for this request (in case
        // the destination index shifted between paginated reads).
        const existingJobs = await hotelProbeJobRepository.findBySearchRequest(requestId);
        const alreadyProbed = new Set(existingJobs.map((j) => j.hotelCode));
        const freshHotels = batch.filter((h) => !alreadyProbed.has(h.hotelCode));

        // Same server-side meal-type fallback as the main search flow.
        // Paginated follow-up batches otherwise pass through `params.mealType`
        // raw — a missing value here would silently drop the meal filter for
        // every additional batch, causing the same #522-style incident.
        const resolvedMealTypeAdditional = resolveMealType(params.mealType, request as any);

        for (const dbHotel of freshHotels) {
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
                mealType: resolvedMealTypeAdditional,
                markupPercent,
                expandedRooms,
                dominantRoomType,
                roomTypeTargets,
            });
        }

        const nextOffset = paginationContext.nextOffset + batch.length;
        logger.info(
            {
                requestId,
                queued: freshHotels.length,
                skippedDuplicates: batch.length - freshHotels.length,
                offset: paginationContext.nextOffset,
                nextOffset,
                totalCandidates: paginationContext.totalCandidates,
            },
            'Search pagination: additional batch queued',
        );

        return {
            decision: 'queued',
            queuedCount: freshHotels.length,
            queuedHotelCodes: freshHotels.map((h) => h.hotelCode),
            nextOffset,
        };
    }

    /**
     * User-triggered "Search More" — queue ONE additional 200-hotel batch at
     * the current destination/star level, picking up exactly where the
     * post-probe watcher left off. Reads the persisted cursor on the
     * BookingRequest (written by the watcher just before searchSettled).
     *
     * Differences from the watcher's internal pagination loop:
     *   - Skips the MAX_SEARCH_BATCHES ceiling (`bypassCeiling: true`) — the
     *     user is in control of when to stop clicking.
     *   - Does NOT advance the relaxation ladder. If the destination at the
     *     current level is fully drained, we return `destination_exhausted`
     *     and clear the cursor so the FE can hide the button.
     *   - Spawns a minimal mini-watcher that waits for the new probes to
     *     settle, advances the cursor's `nextOffset`, flips phase back to
     *     'settled', and re-broadcasts `searchSettled`.
     *
     * Decisions returned to the caller:
     *   - 'queued'                : the next batch is queued + mini-watcher running.
     *   - 'destination_exhausted' : nothing left to probe at this level; cursor cleared.
     *   - 'in_progress'           : another Search More / fresh search is already running.
     *   - 'no_cursor'             : no cursor is persisted yet (pre-feature row, or search exhausted).
     *   - 'exhausted'             : the request's search ended in 'exhausted' — no Search More.
     */
    /**
     * Given the cursor's current star list, return the next ring tier
     * that strictly widens it (adds at least one new star within ±1 of
     * the requested centres). Returns null when the ring is fully walked.
     *
     * Used by Search More to climb the expanding ring tier-by-tier as the
     * user keeps clicking, AND by the controller's `canSearchMore` check
     * so the FE knows whether the button is still actionable.
     */
    private findNextRingTier(
        currentStarList: number[],
        requestedStarRatings: number[],
    ): number[] | null {
        if (requestedStarRatings.length === 0) return null; // "any rating" — no widening possible
        const ladder = buildExpandingRingLadder(requestedStarRatings);
        const currentSet = new Set(currentStarList);
        // Walk the ring; the first tier that adds a NEW star wins.
        for (const tier of ladder) {
            if (tier.some((s) => !currentSet.has(s))) return tier;
        }
        return null;
    }

    /**
     * Returns true when the FE should render the Search More button.
     * Available when EITHER:
     *   - the current star band still has hotels to probe (cursor.nextOffset
     *     < cursor.totalCandidates), OR
     *   - the request has at least one more ring tier to widen to.
     */
    async canSearchMore(requestId: string): Promise<boolean> {
        const phase = await requestRepository.getSearchPhase(requestId);
        if (phase !== 'settled') return false;
        const cursor = await requestRepository.getSearchPaginationCursor(requestId);
        if (!cursor) return false;

        // (a) Current band has hotels left — checked against ACTUAL probed
        // hotel count, not just the cursor's nextOffset. Multiple Search
        // More clicks can race with the mini-watcher's cursor write, so
        // the cursor sometimes lags behind reality. The DB-truth count
        // catches that and hides the button when every hotel in the
        // current band has already been probed.
        const probedCount = await hotelProbeJobRepository.countBySearchRequest(requestId);
        if (probedCount < cursor.totalCandidates) return true;

        // (b) Ring has more tiers to widen into.
        const request = await requestRepository.findById(requestId);
        const requestedStarRatings = resolveRequestedStars(request);
        const next = this.findNextRingTier(cursor.starRatings, requestedStarRatings);
        return next !== null;
    }

    async searchMoreForRequest(
        requestId: string,
        params: { mealType?: string; markupPercent?: number; currencyCode?: string; nationalityCode?: string; waitSeconds?: number } = {},
    ): Promise<{
        decision: 'queued' | 'destination_exhausted' | 'in_progress' | 'no_cursor' | 'exhausted';
        message?: string;
        queuedCount?: number;
        nextOffset?: number;
        sseEndpoint?: string;
        statusEndpoint?: string;
    }> {
        const phase = await requestRepository.getSearchPhase(requestId);
        if (phase === 'exhausted') {
            return { decision: 'exhausted', message: 'Destination already fully exhausted.' };
        }
        if (phase === 'in_progress') {
            return { decision: 'in_progress', message: 'A search is already in progress for this request.' };
        }

        let cursor = await requestRepository.getSearchPaginationCursor(requestId);
        if (!cursor) {
            return { decision: 'no_cursor', message: 'Search More not available — run a fresh search first.' };
        }

        // If the current band is already drained, widen to the next ring
        // tier BEFORE we flip phase. This means the user's first click on
        // a "drained current band" request immediately starts a fresh
        // probe at the next-wider star tier.
        if (cursor.nextOffset >= cursor.totalCandidates) {
            const request = await requestRepository.findById(requestId);
            const requestedStarRatings = resolveRequestedStars(request);
            const nextTier = this.findNextRingTier(cursor.starRatings, requestedStarRatings);
            if (!nextTier) {
                // Ring fully walked AND current band drained — clean up.
                try {
                    await requestRepository.setSearchPaginationCursor(requestId, null);
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(null) on ring exhausted failed');
                }
                return {
                    decision: 'destination_exhausted',
                    message: 'All star tiers fully explored.',
                    queuedCount: 0,
                    nextOffset: cursor.nextOffset,
                };
            }
            const newTotal = await hotelSearchRepository.countHotelsByDestination(
                cursor.usedDestinationId,
                nextTier,
            );
            // Reset the cursor to walk the wider band from the start. The
            // de-dup inside enqueueAdditionalCandidates will skip already-
            // probed hotels at narrower bands.
            cursor = {
                usedDestinationId: cursor.usedDestinationId,
                starRatings: nextTier,
                totalCandidates: newTotal,
                nextOffset: 0,
            };
            try {
                await requestRepository.setSearchPaginationCursor(requestId, cursor);
            } catch (err: any) {
                logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(widen) in searchMore failed');
            }
            logger.info(
                { requestId, newStarList: nextTier, newTotal },
                'Search More: widened star band to next ring tier',
            );
        }

        // Flip phase to in_progress BEFORE queueing so a racing second click
        // sees the in_progress phase and bails out cleanly.
        try {
            await requestRepository.updateSearchPhase(requestId, 'in_progress');
        } catch (err: any) {
            logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(in_progress) in searchMore failed — continuing');
        }

        const result = await this.enqueueAdditionalCandidates(
            requestId,
            cursor,
            params,
            { bypassCeiling: true },
        );

        if (result.decision !== 'queued') {
            // Destination fully drained at this level — clear cursor, flip
            // phase back, and notify the FE so the button hides.
            try {
                await requestRepository.setSearchPaginationCursor(requestId, null);
            } catch (err: any) {
                logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(null) in searchMore failed');
            }
            try {
                await requestRepository.updateSearchPhase(requestId, 'settled');
            } catch (err: any) {
                logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(settled) in searchMore failed');
            }
            const successCount = await hotelProbeJobRepository.countViable(requestId);
            broadcast(requestId, 'searchSettled', {
                requestId,
                finalLevel: 'searchMoreExhausted' as any,
                successCount,
                totalCount: cursor.totalCandidates,
            });
            return {
                decision: 'destination_exhausted',
                message: 'No more hotels available at this level.',
                queuedCount: 0,
                nextOffset: cursor.nextOffset,
            };
        }

        // Fire-and-forget mini-watcher. Waits for the new batch to settle,
        // advances cursor, flips phase back to 'settled', re-broadcasts.
        const newNextOffset = result.nextOffset;
        setImmediate(() => {
            this.waitForProbeJobsToTerminate(requestId)
                .then(async (probeResult) => {
                    try {
                        await requestRepository.setSearchPaginationCursor(requestId, {
                            ...cursor,
                            nextOffset: newNextOffset,
                        });
                    } catch (err: any) {
                        logger.warn({ err: err?.message, requestId }, 'setSearchPaginationCursor(advance) in searchMore failed');
                    }
                    try {
                        await requestRepository.updateSearchPhase(requestId, 'settled');
                    } catch (err: any) {
                        logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(settled) in searchMore mini-watcher failed');
                    }
                    const successCount = await hotelProbeJobRepository.countViable(requestId);
                    broadcast(requestId, 'searchSettled', {
                        requestId,
                        finalLevel: 'searchMore' as any,
                        successCount,
                        totalCount: probeResult.totalCount,
                    });
                })
                .catch((err) => {
                    logger.error({ err: err?.message, requestId }, 'Search More mini-watcher crashed');
                });
        });

        return {
            decision: 'queued',
            queuedCount: result.queuedCount,
            nextOffset: newNextOffset,
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
     *
     * `markupPercent` is optional — when omitted, the live Settings value is
     * used (read from the warm cache populated by the orchestrator above).
     * Callers in a hot loop should pre-resolve the percent once and pass it
     * in explicitly.
     */
    calculateSellPrice(
        buyingPrice: number,
        markupPercent?: number,
    ): { buyingPrice: number; sellPrice: number; markupPercent: number } {
        const effectiveMarkup = markupPercent ?? getDefaultMarkupPercentSync();
        const raw = buyingPrice * (1 + effectiveMarkup / 100);
        const rounded = Math.ceil(raw);
        let psychPrice = rounded;
        if (rounded % 10 === 0) psychPrice = rounded - 2; // €200 → €198
        else if (rounded % 5 === 0) psychPrice = rounded - 1; // €195 → €194

        return { buyingPrice, sellPrice: psychPrice, markupPercent: effectiveMarkup };
    }

    /**
     * Per-room-type sell-price calculator.
     *
     * Requested by the client (2026-07-14): "The system should calculate
     * separate selling prices for each room type based on that room type's
     * supplier prices." Previously we took a single mid-range net price
     * and applied it to every room type, causing single rooms and
     * quadruples to be quoted at the same rate — which is wrong for
     * both parties (undercharges on the expensive types, overcharges on
     * the cheap ones).
     *
     * This is the formula (Option A — direct per-type):
     *
     *   raw    = net × (1 + markup% / 100)         ← same markup for all types
     *   ceil   = Math.ceil(raw)                     ← never round DOWN
     *   psych  = ceil - 2  if ceil % 10 == 0        ← €200 → €198
     *          | ceil - 1  if ceil % 5 == 0         ← €195 → €194
     *          | ceil      otherwise
     *   sell   = psych
     *
     * We return the FULL calculation trail per row so the FE can show
     * the "how was this calculated" panel the client asked for:
     *   { roomType, buyingPrice, markupPercent, raw, ceil, psychAdjustment, sellPrice }
     *
     * @param entries per-type net prices, one per row
     * @param markupPercent optional override; falls back to Settings value
     */
    calculateSellPricesByType(
        entries: Array<{ roomType: string; buyingPrice: number }>,
        markupPercent?: number,
    ): {
        markupPercent: number;
        results: Array<{
            roomType: string;
            buyingPrice: number;
            markupPercent: number;
            raw: number;              // net × (1 + markup%) — the pre-rounding value
            ceil: number;             // Math.ceil(raw)
            psychAdjustment: number;  // -2, -1, or 0 depending on ceil
            sellPrice: number;        // final customer-facing price
        }>;
    } {
        const effectiveMarkup = markupPercent ?? getDefaultMarkupPercentSync();
        const results = entries.map((e) => {
            const raw = e.buyingPrice * (1 + effectiveMarkup / 100);
            const ceil = Math.ceil(raw);
            let psychAdjustment = 0;
            if (ceil % 10 === 0) psychAdjustment = -2;
            else if (ceil % 5 === 0) psychAdjustment = -1;
            const sellPrice = ceil + psychAdjustment;
            return {
                roomType: e.roomType,
                buyingPrice: e.buyingPrice,
                markupPercent: effectiveMarkup,
                raw,
                ceil,
                psychAdjustment,
                sellPrice,
            };
        });
        return { markupPercent: effectiveMarkup, results };
    }

    /**
     * Startup sweeper for orphaned searches.
     *
     * A search can get stuck in `search_phase = 'in_progress'` if the in-memory
     * watcher dies (server restart, silent crash, etc.) and leaves the row
     * never transitioning to a terminal phase. Without a sweeper, the polling
     * frontend waits forever and the user sees a stuck loading indicator.
     *
     * On every server start, this scans for `in_progress` requests older than
     * `staleAfterMinutes` and resolves them to the correct terminal phase
     * based on their current probe-job state:
     *   - all jobs terminal AND viable > 0   → 'settled' (show what we have)
     *   - all jobs terminal AND viable === 0 → 'exhausted' (mark needs_manual_handling)
     *   - some jobs pending                  → skip (worker probably still processing)
     *
     * Phase 1 scope: no automatic pagination continuation. If a search settled
     * at 12 viable but the user wants 50, they re-trigger the search manually
     * — same UX as today's "show alternatives" flow. Auto-resume is a separate
     * ticket because it requires persisting the pagination context.
     */
    async resumeOrphanedSearches(staleAfterMinutes = 5): Promise<{
        scanned: number;
        settled: number;
        exhausted: number;
        skipped: number;
    }> {
        const stalled = await requestRepository.findStalledInProgressSearches(staleAfterMinutes);
        const counters = { scanned: stalled.length, settled: 0, exhausted: 0, skipped: 0 };

        if (stalled.length === 0) {
            logger.info('Startup sweeper: no stalled in_progress searches found');
            return counters;
        }

        logger.warn({ count: stalled.length }, 'Startup sweeper: found stalled in_progress searches — resolving');

        const TERMINAL = new Set(['COMPLETED', 'SKIPPED_INSUFFICIENT', 'FAILED']);

        for (const req of stalled) {
            try {
                const jobs = await hotelProbeJobRepository.findBySearchRequest(req.id);
                const allTerminal = jobs.length === 0 || jobs.every((j: any) => TERMINAL.has(j.status));

                if (!allTerminal) {
                    // Worker probably still processing. Leave it alone — if the
                    // worker is genuinely dead, requeueStaleJobs will pick the
                    // pending ones back up on the next probe cycle.
                    counters.skipped++;
                    logger.info(
                        { requestId: req.id, refNum: req.referenceNumber, jobs: jobs.length },
                        'Startup sweeper: search has pending jobs — skipping',
                    );
                    continue;
                }

                const viableCount = jobs.filter((j: any) => j.status === 'COMPLETED').length;

                if (viableCount > 0) {
                    // Surface what we found — the user can re-trigger if they want more.
                    await requestRepository.updateSearchPhase(req.id, 'settled');
                    counters.settled++;
                    logger.info(
                        { requestId: req.id, refNum: req.referenceNumber, viableCount, jobsProbed: jobs.length },
                        'Startup sweeper: resolved to settled (had viable hotels)',
                    );
                } else {
                    // Nothing usable — flag for manual handling, same path the
                    // watcher would have taken on its own.
                    await requestRepository.updateSearchPhase(req.id, 'exhausted');
                    if ((req as any).status !== BookingRequestStatus.needs_manual_handling) {
                        await requestRepository.updateStatus(
                            req.id,
                            BookingRequestStatus.needs_manual_handling,
                        );
                    }
                    counters.exhausted++;
                    logger.info(
                        { requestId: req.id, refNum: req.referenceNumber, jobsProbed: jobs.length },
                        'Startup sweeper: resolved to exhausted (no viable hotels)',
                    );
                }
            } catch (err: any) {
                logger.error(
                    { err: err?.message, requestId: req.id, refNum: req.referenceNumber },
                    'Startup sweeper: failed to resolve a stalled search — leaving phase unchanged',
                );
                // Best effort — one bad row should not abort the whole sweep.
            }
        }

        logger.info(counters, 'Startup sweeper: finished');
        return counters;
    }
}

export default new HotelSearchService();
