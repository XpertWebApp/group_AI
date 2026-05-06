"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotelSearchService = void 0;
exports.expandRequestRooms = expandRequestRooms;
exports.buildRoomTypeTargets = buildRoomTypeTargets;
exports.buildProbeBatch = buildProbeBatch;
const crypto_1 = require("crypto");
const request_repository_1 = __importDefault(require("../repositories/request.repository"));
const hotelSearch_repository_1 = __importDefault(require("../repositories/hotelSearch.repository"));
const hotelProbeJob_repository_1 = __importDefault(require("../repositories/hotelProbeJob.repository"));
const wbe_client_service_1 = __importDefault(require("./wbe.client.service"));
const hotelProbe_publisher_1 = require("../queue/hotelProbe.publisher");
const logger_1 = __importDefault(require("../utils/logger"));
const pricing_1 = require("../utils/pricing");
const supplierLimits_1 = require("../config/supplierLimits");
const probeConfig_1 = require("../config/probeConfig");
const roomUtils_1 = require("../utils/roomUtils");
const searchRelaxation_1 = require("./searchRelaxation");
const audit_1 = require("../utils/audit");
const client_1 = require("@prisma/client");
const sseManager_1 = require("./sseManager");
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
const MAX_POLL_WAIT_MS = 60000;
/** Option detail cache TTL in hours. */
const OPTION_DETAIL_TTL_HOURS = 2;
// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Expand the booking request rooms JSON into a flat ordered list of individual rooms.
 * e.g. { double: 3, single: 1 } → [2-adult, 2-adult, 2-adult, 1-adult]
 * Used by buildProbeBatch to compose the Rooms array for each probe call.
 */
function expandRequestRooms(rooms) {
    if (!rooms || typeof rooms !== 'object')
        return [{ adults: ADULTS_PER_ROOM, children: 0, childrenAges: [] }];
    // Normalize to avoid double-counting double/twin when new breakdown fields are present
    const normalized = (0, roomUtils_1.normalizeRoomCounts)(rooms);
    const expanded = [];
    for (const [type, count] of Object.entries(normalized)) {
        const n = Number(count) || 0;
        if (n <= 0)
            continue;
        const adults = probeConfig_1.ROOM_TYPE_ADULTS[type] ?? ADULTS_PER_ROOM;
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
function buildRoomTypeTargets(rooms) {
    if (!rooms || typeof rooms !== 'object')
        return [];
    // Normalize to avoid double-counting double/twin when new breakdown fields are present
    const normalized = (0, roomUtils_1.normalizeRoomCounts)(rooms);
    const targets = [];
    for (const [type, count] of Object.entries(normalized)) {
        const n = Number(count) || 0;
        if (n <= 0)
            continue;
        const adults = probeConfig_1.ROOM_TYPE_ADULTS[type] ?? ADULTS_PER_ROOM;
        targets.push({
            roomType: type,
            requested: n,
            probeLimit: n * probeConfig_1.PROBE_MULTIPLIER,
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
function buildProbeBatch(expandedRooms, startRoomId, batchSize = probeConfig_1.PROBE_BATCH_SIZE) {
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
function buildSearchRooms() {
    return Array.from({ length: SEARCH_ROOMS }, (_, i) => ({
        RoomID: i + 1,
        AdultsNo: String(ADULTS_PER_ROOM),
        ChildrenNo: '0',
        ChildrenAges: [],
    }));
}
/** Safely read a field from an object that may use PascalCase or camelCase. */
function field(obj, ...keys) {
    for (const k of keys) {
        if (obj != null && obj[k] !== undefined)
            return obj[k];
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
function selectMidRange(prices, trimPct = 20) {
    if (prices.length === 0)
        return [];
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
function determineStatus(totalAvailable, requested, hasUnlimited) {
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
function buildSupplierSplit(midBandOptions, targetContribution, totalRoomsNeeded) {
    const sorted = [...midBandOptions].sort((a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight);
    const split = [];
    let remaining = targetContribution;
    for (const opt of sorted) {
        if (remaining <= 0)
            break;
        const cap = (0, supplierLimits_1.getCappedMax)(opt.supplierCode, totalRoomsNeeded);
        const allocate = Math.min(cap, remaining);
        if (allocate <= 0)
            continue;
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
function getDominantRoomType(rooms) {
    if (!rooms || typeof rooms !== 'object')
        return null;
    const useNewBreakdown = (0, roomUtils_1.hasNewDoubleBreakdown)(rooms);
    const types = [
        // Legacy double/twin — only counted when new breakdown fields are absent
        { type: 'double', count: useNewBreakdown ? 0 : (rooms.double ?? 0) },
        { type: 'twin', count: useNewBreakdown ? 0 : (rooms.twin ?? 0) },
        // New breakdown fields
        { type: 'standardDoubleBeds', count: rooms.standardDoubleBeds ?? 0 },
        { type: 'twinBeds', count: rooms.twinBeds ?? 0 },
        // Other types — always counted
        { type: 'single', count: rooms.single ?? 0 },
        { type: 'triple', count: rooms.triple ?? 0 },
        { type: 'quadruple', count: rooms.quadruple ?? 0 },
        { type: 'suite', count: rooms.suites ?? 0 },
    ];
    const max = types.reduce((a, b) => (b.count > a.count ? b : a), { type: null, count: 0 });
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
function matchesRoomType(roomDescriptions, requestedType) {
    if (!requestedType)
        return true;
    if (roomDescriptions.length === 0)
        return true; // no description from WBE — include by default
    const descs = roomDescriptions.map((d) => d.toLowerCase());
    const type = requestedType.toLowerCase();
    const acceptable = [type];
    if (type === 'single')
        acceptable.push('twin');
    if (type === 'double')
        acceptable.push('twin');
    if (type === 'triple')
        acceptable.push('quad');
    return descs.some((d) => acceptable.some((kw) => d.includes(kw)));
}
/**
 * Step 2.3 — Supplier deduplication.
 * If the same supplier code appears more than once, keep only the lowest-priced entry.
 * Prevents double-counting a single supplier's physical room inventory.
 */
function deduplicateBySupplier(options) {
    const map = new Map();
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
function computeHotelContribution(midBandOptions, hotelTotalRooms, totalRoomsNeeded, roomsStillNeeded) {
    const totalSupplierClaim = midBandOptions.reduce((sum, o) => sum + (0, supplierLimits_1.getCappedMax)(o.supplierCode, totalRoomsNeeded), 0);
    let effectiveCapacity = totalSupplierClaim;
    let inventoryOverlapFlag = false;
    let overlapDetected = false;
    let note;
    if (hotelTotalRooms && hotelTotalRooms > 0) {
        if (totalSupplierClaim > hotelTotalRooms * 0.70) {
            // Multiple suppliers likely reselling same physical rooms
            effectiveCapacity = Math.floor(hotelTotalRooms * 0.60);
            overlapDetected = true;
            note = `Inventory overlap detected — capped at 60% of hotel physical capacity (${hotelTotalRooms} rooms).`;
        }
    }
    else {
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
function parseWbeOptions(wbeHotelOptions, nights) {
    const result = [];
    for (const opt of wbeHotelOptions ?? []) {
        const tid = field(opt, 'TID', 'Tid', 'tid');
        const rawPrice = field(opt, 'TotalPrice', 'totalPrice', 'Price', 'price');
        // tid and rawPrice are absolutely required to process an option
        if (!tid || rawPrice === undefined)
            continue;
        // SupplierCode confirmed present in live API response. Fall back to 'UNKNOWN'
        // so options are not silently dropped if a new supplier appears.
        const supplierCode = field(opt, 'SupplierCode', 'supplierCode', 'Supplier', 'supplier') ?? 'UNKNOWN';
        const currency = field(opt, 'Currency', 'currency', 'CurrencyCode') ?? 'EUR';
        const freeCancellation = field(opt, 'FreeCancellation', 'freeCancellation') ?? false;
        const onRequest = field(opt, 'OnRequest', 'onRequest') ?? false;
        const mealType = field(opt, 'MealType', 'mealType', 'BoardType', 'boardType') ?? '';
        const mealName = field(opt, 'MealName', 'mealName', 'BoardName', 'boardName') ?? '';
        const updatedOptionsNeeded = field(opt, 'UpdatedOptionsNeeded', 'updatedOptionsNeeded') ?? false;
        // ClxDeadline confirmed from live response. Keep CxlDeadline as fallback for compatibility.
        const cancelDeadline = field(opt, 'ClxDeadline', 'clxDeadline', 'CxlDeadline', 'cxlDeadline', 'CancellationDeadline', 'cancellationDeadline') ?? null;
        const providerPrice = field(opt, 'ProviderPrice', 'providerPrice');
        const providerCurrency = field(opt, 'ProviderCurrency', 'providerCurrency');
        // Extract room descriptions from the Rooms array
        const rawRooms = field(opt, 'Rooms', 'rooms') ?? [];
        const roomDescriptions = rawRooms
            .map((r) => field(r, 'Description', 'description', 'RoomName', 'roomName') ?? '')
            .filter(Boolean);
        // Use the actual number of rooms WBE returned in this option (not a hardcoded batch size).
        // WBE can return options with fewer rooms than requested when partial availability exists.
        const roomsInOption = rawRooms.length > 0 ? rawRooms.length : SEARCH_ROOMS;
        const pricePerRoomPerNight = (0, pricing_1.normalisePricePerRoomPerNight)(rawPrice, roomsInOption, nights, { tid, supplierCode });
        const maxRoomsFromSupplier = (0, supplierLimits_1.getSupplierMaxRooms)(supplierCode);
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
function parseOptionDetails(raw) {
    const data = raw?.Data ?? raw?.data ?? raw ?? {};
    // CxlPolicy is a nested object under Data
    const cxlPolicy = data?.CxlPolicy ?? data?.cxlPolicy ?? data?.CancellationPolicy ?? {};
    // DayPrices is a nested object under Data
    const dayPricesObj = data?.DayPrices ?? data?.dayPrices ?? {};
    // ── Cancellation policy ──────────────────────────────────────────────────
    const nonRefundable = field(cxlPolicy, 'NonRefundable', 'nonRefundable', 'IsNonRefundable') ?? false;
    // The cancellation deadline — OptionDate is the field confirmed in WBE docs
    const cxlDeadline = field(cxlPolicy, 'OptionDate', 'optionDate', 'CancellationDeadline', 'cancellationDeadline') ??
        null;
    const rawConditions = field(cxlPolicy, 'Conditions', 'conditions', 'CancellationConditions') ?? [];
    const conditions = rawConditions.map((c) => ({
        fromDate: field(c, 'FromDate', 'fromDate', 'From') ?? '',
        toDate: field(c, 'ToDate', 'toDate', 'To') ?? '',
        amount: field(c, 'Amount', 'amount', 'Penalty') ?? 0,
        currency: field(c, 'Currency', 'currency') ?? '',
        text: field(c, 'Text', 'text', 'Description') ?? '',
    }));
    const cxlComment = field(cxlPolicy, 'Comment', 'comment', 'Remarks', 'remarks') ?? undefined;
    const cancellationPolicy = {
        nonRefundable,
        deadline: cxlDeadline,
        conditions,
        comment: cxlComment ?? null,
    };
    // ── Day prices / pricing ─────────────────────────────────────────────────
    const daypricesTotal = field(dayPricesObj, 'TotalPrice', 'totalPrice', 'Total', 'total');
    const daypricesCurrency = field(dayPricesObj, 'Currency', 'currency', 'CurrencyCode');
    const mealType = field(dayPricesObj, 'MealType', 'mealType', 'BoardType');
    const mealName = field(dayPricesObj, 'MealName', 'mealName', 'BoardName');
    const essentialInfo = field(dayPricesObj, 'EssentialInfo', 'essentialInfo', 'EssentialInformation', 'ImportantInfo');
    const supplements = field(dayPricesObj, 'Supplements', 'supplements');
    // Per-room, per-day price breakdown
    const rawRooms = field(dayPricesObj, 'Rooms', 'rooms') ?? [];
    const roomBreakdown = rawRooms.map((r) => {
        const roomId = field(r, 'RoomId', 'roomId', 'RoomID', 'roomID') ?? 0;
        const description = field(r, 'Description', 'description', 'RoomName') ?? '';
        const rawPrices = field(r, 'Prices', 'prices', 'DayPrices') ?? [];
        const prices = rawPrices.map((p) => ({
            date: field(p, 'Date', 'date') ?? '',
            price: field(p, 'Price', 'price', 'Amount') ?? 0,
        }));
        return { roomId, description, prices };
    });
    // Provider price (may be at the Data level or inside DayPrices)
    const providerPrice = field(data, 'ProviderPrice', 'providerPrice') ??
        field(dayPricesObj, 'ProviderPrice', 'providerPrice');
    const supplierCode = field(data, 'SupplierCode', 'supplierCode') ??
        field(dayPricesObj, 'SupplierCode', 'supplierCode');
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
class HotelSearchService {
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
    async findCandidatesWithRelaxation(opts) {
        const startIdx = Math.max(0, Math.min(opts.startLevelIndex ?? 0, searchRelaxation_1.RELAXATION_LADDER.length - 1));
        const tryAtDestination = async (destId, fromIndex) => {
            for (let i = fromIndex; i < searchRelaxation_1.RELAXATION_LADDER.length; i++) {
                const config = searchRelaxation_1.RELAXATION_LADDER[i];
                const stars = (0, searchRelaxation_1.buildStarList)(opts.requestedStarRating, config.starWindow);
                let dbHotels = await hotelSearch_repository_1.default.getHotelCodesByDestination(destId, stars);
                if (dbHotels.length === 0)
                    continue;
                if (config.keepFacilities && opts.facilityIds && opts.facilityIds.length > 0) {
                    const allCodes = dbHotels.map((h) => h.hotelCode);
                    const matchingCodes = await hotelSearch_repository_1.default.filterHotelCodesByFacilities(allCodes, opts.facilityIds);
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
        const ancestry = await hotelSearch_repository_1.default.getDestinationAncestry(opts.destinationId);
        const nearby = await hotelSearch_repository_1.default.getNearbyDestinations(opts.destinationId, 5);
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
    async waitForProbeJobsToTerminate(requestId) {
        const TERMINAL = new Set(['COMPLETED', 'SKIPPED_INSUFFICIENT', 'FAILED']);
        const POLL_INTERVAL_MS = 5000;
        const MAX_WAIT_MS = 5 * 60 * 1000; // 5 min per relaxation iteration
        const start = Date.now();
        while (Date.now() - start < MAX_WAIT_MS) {
            const jobs = await hotelProbeJob_repository_1.default.findBySearchRequest(requestId);
            if (jobs.length === 0) {
                return { successCount: 0, totalCount: 0, timedOut: false };
            }
            // Only consider 'main' probes — alternatives are user-driven and
            // the watcher's job is to advance the MAIN search ladder.
            const mainJobs = jobs.filter((j) => (j.searchKind ?? 'main') === 'main');
            if (mainJobs.length === 0) {
                return { successCount: 0, totalCount: 0, timedOut: false };
            }
            const allTerminal = mainJobs.every((j) => TERMINAL.has(j.status));
            if (allTerminal) {
                return {
                    successCount: mainJobs.filter((j) => j.status === 'COMPLETED').length,
                    totalCount: mainJobs.length,
                    timedOut: false,
                };
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        // Timed out — return whatever we have
        const jobs = await hotelProbeJob_repository_1.default.findBySearchRequest(requestId);
        const mainJobs = jobs.filter((j) => (j.searchKind ?? 'main') === 'main');
        return {
            successCount: mainJobs.filter((j) => j.status === 'COMPLETED').length,
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
    async runPostProbeRelaxation(requestId, params, startLevel) {
        let currentLevel = startLevel;
        const MAX_ITERATIONS = searchRelaxation_1.RELAXATION_LADDER.length;
        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            const probeResult = await this.waitForProbeJobsToTerminate(requestId);
            // 1+ probe succeeded — exit. User has hotels to look at; if there
            // are between 1 and 4 the FE will offer "Show Alternatives".
            if (probeResult.successCount > 0) {
                logger_1.default.info({ requestId, level: currentLevel, successCount: probeResult.successCount }, 'Post-probe relaxation: probes succeeded — watcher exiting');
                (0, sseManager_1.broadcast)(requestId, 'searchSettled', {
                    requestId,
                    finalLevel: currentLevel,
                    successCount: probeResult.successCount,
                    totalCount: probeResult.totalCount,
                });
                return;
            }
            if (probeResult.timedOut) {
                logger_1.default.warn({ requestId, level: currentLevel }, 'Post-probe relaxation: timed out waiting for probes — watcher exiting');
                return;
            }
            if (probeResult.totalCount === 0) {
                logger_1.default.info({ requestId, level: currentLevel }, 'Post-probe relaxation: no probes found for this request — watcher exiting');
                return;
            }
            // Zero successes — advance the relaxation ladder.
            const currentIndex = searchRelaxation_1.RELAXATION_LADDER.findIndex((l) => l.level === currentLevel);
            const nextIndex = currentIndex + 1;
            if (currentIndex < 0 || nextIndex >= searchRelaxation_1.RELAXATION_LADDER.length) {
                // Ladder exhausted — flag as needs_manual_handling.
                logger_1.default.info({ requestId, level: currentLevel }, 'Post-probe relaxation: ladder exhausted — flagging as needs_manual_handling');
                await request_repository_1.default.updateStatus(requestId, client_1.BookingRequestStatus.needs_manual_handling);
                (0, sseManager_1.broadcast)(requestId, 'searchExhausted', {
                    requestId,
                    finalLevel: currentLevel,
                });
                return;
            }
            const nextLevel = searchRelaxation_1.RELAXATION_LADDER[nextIndex].level;
            logger_1.default.info({ requestId, fromLevel: currentLevel, toLevel: nextLevel }, 'Post-probe relaxation: advancing level');
            await (0, audit_1.logAuditEvent)({
                action: 'search_post_probe_relaxation',
                entity: 'booking_request',
                entityId: requestId,
                details: { fromLevel: currentLevel, toLevel: nextLevel, iteration: iter + 1 },
            });
            // Notify the FE so it can update banners / loading copy.
            (0, sseManager_1.broadcast)(requestId, 'searchRelaxed', {
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
                logger_1.default.info({ requestId, level: nextLevel }, 'Post-probe relaxation: re-search returned manualRequestOnly — watcher exiting');
                return;
            }
            const newAppliedLevel = result.relaxation?.level
                ?? searchRelaxation_1.RELAXATION_LADDER[nextIndex]?.level;
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
    async searchForRequest(requestId, params = {}, internalOpts) {
        // 1. Load request
        const request = await request_repository_1.default.findById(requestId);
        if (!request) {
            throw { status: 404, message: 'Booking request not found', code: 'NOT_FOUND' };
        }
        // In-flight guard: if the FE re-clicks "Search" while a previous search
        // is still processing (probes in QUEUED/RUNNING/PROBING, or a watcher
        // is still iterating), DON'T spawn a duplicate search. Just return the
        // current snapshot. Skipped for internal recursive calls from the
        // watcher (those already own the in-flight slot).
        if (!internalOpts?.suppressWatcher) {
            const existingJobs = await hotelProbeJob_repository_1.default.findBySearchRequest(requestId);
            const liveJobs = existingJobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING' || j.status === 'PROBING');
            if (liveJobs.length > 0) {
                logger_1.default.info({ requestId, liveCount: liveJobs.length }, 'searchForRequest: search already in flight — returning current snapshot, skipping duplicate spawn');
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
        const totalRooms = (0, roomUtils_1.countTotalRooms)(request.rooms);
        if (totalRooms === 0) {
            throw { status: 400, message: 'Booking request has no rooms specified', code: 'INVALID_REQUEST' };
        }
        const nights = request.nights;
        const destinationId = request.destinationId;
        const requestedStarRating = request.starRating ? Number(request.starRating) : null;
        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        const nationalityCode = params.nationalityCode ?? request.nationalityCode ?? 'HU';
        const includeAlternativeStars = params.includeAlternativeStars !== false;
        const waitSeconds = params.waitSeconds ?? probeConfig_1.PROBE_WAIT_SECONDS;
        const markupPercent = 18;
        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);
        const dominantRoomType = getDominantRoomType(request.rooms);
        const expandedRooms = expandRequestRooms(request.rooms);
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
        const relaxationBanner = (0, searchRelaxation_1.describeRelaxation)(relaxResult.appliedLevel);
        const usedDifferentDestination = relaxResult.usedDestinationId !== destinationId;
        let destinationFallbackInfo = null;
        if (usedDifferentDestination && dbHotels.length > 0) {
            const [origName, usedName] = await Promise.all([
                hotelSearch_repository_1.default.getDestinationName(destinationId),
                hotelSearch_repository_1.default.getDestinationName(relaxResult.usedDestinationId),
            ]);
            destinationFallbackInfo = {
                originalDestinationId: destinationId,
                originalDestinationName: origName ?? request.destinationName ?? '',
                usedDestinationId: relaxResult.usedDestinationId,
                usedDestinationName: usedName ?? '',
                bannerMessage: (0, searchRelaxation_1.describeDestinationFallback)(dbHotels.length, origName ?? request.destinationName ?? 'the requested area', usedName ?? 'a wider area'),
            };
        }
        // Audit log when relaxation actually kicked in (skip the "default" levels
        // exact / star_pm1 to avoid log spam — those are normal behaviour).
        if (relaxResult.appliedLevel !== 'exact' &&
            relaxResult.appliedLevel !== 'star_pm1') {
            await (0, audit_1.logAuditEvent)({
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
            logger_1.default.warn({ requestId, destinationId }, 'No hotels found at any relaxation level or fallback destination');
            // Slice 2 — flag the request so staff sees the orange badge & banner.
            // Idempotent: only write when status is actually changing.
            if (request.status !== client_1.BookingRequestStatus.needs_manual_handling) {
                await request_repository_1.default.updateStatus(requestId, client_1.BookingRequestStatus.needs_manual_handling);
            }
            (0, sseManager_1.broadcast)(requestId, 'searchExhausted', {
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
        await hotelProbeJob_repository_1.default.deleteBySearchRequest(requestId);
        // Dispatch one HotelProbeJob per hotel to RabbitMQ
        const roomTypeTargets = buildRoomTypeTargets(request.rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * probeConfig_1.PROBE_MULTIPLIER;
        let jobsQueued = 0;
        // If the relaxation pipeline reached level >= meal_dropped, drop the
        // mealType filter at probe time too (otherwise we'd lose hotels that
        // only have non-matching meal options).
        const RELAXED_PAST_MEAL = new Set([
            'meal_dropped',
            'location_dropped',
            'facilities_dropped',
        ]);
        const probeMealType = RELAXED_PAST_MEAL.has(relaxResult.appliedLevel)
            ? undefined
            : params.mealType;
        for (const dbHotel of dbHotels) {
            const jobId = (0, crypto_1.randomUUID)();
            await hotelProbeJob_repository_1.default.create({
                id: jobId,
                searchRequestId: requestId,
                hotelCode: dbHotel.hotelCode,
                requestedRooms: totalRooms,
                probeLimit,
            });
            await (0, hotelProbe_publisher_1.publishHotelProbeJob)({
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
            });
            jobsQueued++;
        }
        logger_1.default.info({
            requestId,
            totalCandidates: dbHotels.length,
            jobsQueued,
            appliedLevel: relaxResult.appliedLevel,
            usedDestinationId: relaxResult.usedDestinationId,
        }, 'Hotel probe jobs queued');
        // Slice 2 — auto-clear the manual-handling flag if a previous search
        // failed but this re-search (likely after staff edited dates / destination)
        // succeeded in finding candidates. Brings the request back to `pending`
        // so the orange badge / banner go away on the next page load.
        if (request.status === client_1.BookingRequestStatus.needs_manual_handling) {
            await request_repository_1.default.updateStatus(requestId, client_1.BookingRequestStatus.pending);
        }
        // Spawn the post-probe relaxation watcher (fire and forget). Skipped
        // when this call is itself a recursive re-trigger from the watcher
        // (otherwise we'd nest watchers infinitely).
        if (!internalOpts?.suppressWatcher) {
            setImmediate(() => {
                this.runPostProbeRelaxation(requestId, params, relaxResult.appliedLevel).catch((err) => {
                    logger_1.default.error({ err: err?.message, requestId }, 'Post-probe relaxation watcher crashed');
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
    async searchAlternativesForRequest(requestId, params = {}, appliedLevelFromMain) {
        // 1. Load and validate the request — same gate as searchForRequest.
        const request = await request_repository_1.default.findById(requestId);
        if (!request) {
            throw { status: 404, message: 'Booking request not found', code: 'NOT_FOUND' };
        }
        const totalRooms = (0, roomUtils_1.countTotalRooms)(request.rooms);
        if (totalRooms === 0) {
            throw { status: 400, message: 'Booking request has no rooms specified', code: 'INVALID_REQUEST' };
        }
        const nights = request.nights;
        const destinationId = request.destinationId;
        const requestedStarRating = request.starRating ? Number(request.starRating) : null;
        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        const nationalityCode = params.nationalityCode ?? request.nationalityCode ?? 'HU';
        const waitSeconds = params.waitSeconds ?? probeConfig_1.PROBE_WAIT_SECONDS;
        const markupPercent = 18;
        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);
        const dominantRoomType = getDominantRoomType(request.rooms);
        const expandedRooms = expandRequestRooms(request.rooms);
        // 2. Find which hotelCodes are already in the main results — exclude them.
        const existingJobs = await hotelProbeJob_repository_1.default.findBySearchRequest(requestId);
        const excludedHotelCodes = new Set(existingJobs
            .filter((j) => (j.searchKind ?? 'main') === 'main')
            .map((j) => j.hotelCode));
        // 3. Determine where on the ladder to start. If the main search ran at
        //    `exact`, alternatives start at `star_pm1`. If main is unknown, start at 0.
        let startIndex = 0;
        if (appliedLevelFromMain) {
            const mainIndex = searchRelaxation_1.RELAXATION_LADDER.findIndex((l) => l.level === appliedLevelFromMain);
            if (mainIndex >= 0)
                startIndex = mainIndex + 1;
        }
        const found = new Map();
        const collectAtDestination = async (destId, isFallback, fromIndex) => {
            for (let i = fromIndex; i < searchRelaxation_1.RELAXATION_LADDER.length; i++) {
                const config = searchRelaxation_1.RELAXATION_LADDER[i];
                const stars = (0, searchRelaxation_1.buildStarList)(requestedStarRating, config.starWindow);
                let dbHotels = await hotelSearch_repository_1.default.getHotelCodesByDestination(destId, stars);
                if (config.keepFacilities && params.facilityIds && params.facilityIds.length > 0) {
                    const allCodes = dbHotels.map((h) => h.hotelCode);
                    const matchingCodes = await hotelSearch_repository_1.default.filterHotelCodesByFacilities(allCodes, params.facilityIds);
                    const matchingSet = new Set(matchingCodes);
                    dbHotels = dbHotels.filter((h) => matchingSet.has(h.hotelCode));
                }
                for (const h of dbHotels) {
                    if (excludedHotelCodes.has(h.hotelCode))
                        continue;
                    if (found.has(h.hotelCode))
                        continue; // first level wins
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
        const ancestry = await hotelSearch_repository_1.default.getDestinationAncestry(destinationId);
        const nearby = await hotelSearch_repository_1.default.getNearbyDestinations(destinationId, 5);
        for (const destId of [...ancestry, ...nearby]) {
            await collectAtDestination(destId, true, 0);
        }
        if (found.size === 0) {
            logger_1.default.info({ requestId, destinationId, excludedCount: excludedHotelCodes.size }, 'No alternatives found');
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
        const roomTypeTargets = buildRoomTypeTargets(request.rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * probeConfig_1.PROBE_MULTIPLIER;
        let jobsQueued = 0;
        for (const candidate of found.values()) {
            const reason = (0, searchRelaxation_1.describeAlternativeReason)(candidate.level, candidate.fromFallbackDestination);
            const jobId = (0, crypto_1.randomUUID)();
            await hotelProbeJob_repository_1.default.create({
                id: jobId,
                searchRequestId: requestId,
                hotelCode: candidate.hotel.hotelCode,
                requestedRooms: totalRooms,
                probeLimit,
                searchKind: 'alternative',
                alternativeReason: reason,
            });
            await (0, hotelProbe_publisher_1.publishHotelProbeJob)({
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
            });
            jobsQueued++;
        }
        await (0, audit_1.logAuditEvent)({
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
        logger_1.default.info({ requestId, alternativesQueued: jobsQueued, excluded: excludedHotelCodes.size }, 'Alternative hotel probe jobs queued');
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
    async pollUntilFinished(sessionId) {
        const startTime = Date.now();
        const accumulated = [];
        while (Date.now() - startTime < MAX_POLL_WAIT_MS) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            try {
                const update = await wbe_client_service_1.default.getUpdatedOptionsV2({ SessionID: sessionId });
                // Key fix: poll response also uses 'Data' not 'Hotels'
                const hotels = field(update, 'Data', 'data', 'Hotels', 'hotels') ?? [];
                accumulated.push(...hotels);
                const done = field(update, 'Finished', 'finished') ?? false;
                if (done)
                    break;
            }
            catch (err) {
                logger_1.default.warn({ sessionId, error: err.message }, 'Poll GetUpdatedOptions failed');
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
    async fetchOptionDetails(selections) {
        const results = [];
        await Promise.all(selections.map(async ({ sessionId, tid, hotelCode }) => {
            // Check cache first
            const cached = await hotelSearch_repository_1.default.getCachedOptionDetail(tid);
            if (cached && (!cached.expiresAt || cached.expiresAt > new Date())) {
                const cxlDeadline = cached.cxlOptionDate?.toISOString() ?? null;
                const cachedConditions = cached.cxlConditions ?? [];
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
                        roomBreakdown: cached.rooms ?? [],
                        cancellationPolicy: {
                            nonRefundable: cached.nonRefundable ?? false,
                            deadline: cxlDeadline,
                            conditions: cachedConditions.map((c) => ({
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
                const raw = await wbe_client_service_1.default.optionDetailsV2({
                    SessionID: sessionId,
                    TID: tid,
                    HotelCode: hotelCode,
                });
                const parsed = parseOptionDetails(raw);
                const expiresAt = new Date(Date.now() + OPTION_DETAIL_TTL_HOURS * 60 * 60 * 1000);
                await hotelSearch_repository_1.default.upsertOptionDetail({
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
            }
            catch (err) {
                logger_1.default.error({ tid, hotelCode, error: err.message }, 'OptionDetailsV2 failed');
                results.push({
                    tid,
                    hotelCode,
                    cached: false,
                    data: null,
                    parsed: {},
                });
            }
        }));
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
    async generateAutoOffer(requestId, params = {}) {
        const request = await request_repository_1.default.findById(requestId);
        if (!request) {
            throw { status: 404, message: 'Booking request not found', code: 'NOT_FOUND' };
        }
        const totalRooms = (0, roomUtils_1.countTotalRooms)(request.rooms);
        if (totalRooms === 0) {
            throw { status: 400, message: 'Booking request has no rooms specified', code: 'INVALID_REQUEST' };
        }
        const currencyCode = params.currencyCode ?? request.currencyCode ?? 'EUR';
        const nationalityCode = params.nationalityCode ?? request.nationalityCode ?? 'HU';
        const includeAlternativeStars = params.includeAlternativeStars !== false;
        const waitSeconds = params.waitSeconds ?? probeConfig_1.PROBE_WAIT_SECONDS;
        const markupPercent = params.markupPercent ?? 18;
        const checkinDate = request.checkinDate instanceof Date
            ? request.checkinDate.toISOString().split('T')[0]
            : String(request.checkinDate);
        const dominantRoomType = getDominantRoomType(request.rooms);
        const expandedRooms = expandRequestRooms(request.rooms);
        const requestedStarRating = request.starRating ? Number(request.starRating) : null;
        void includeAlternativeStars; // superseded by the explicit relaxation ladder
        // ── "Never say no" candidate selection (auto-offer flow) ──────────
        const relaxResult = await this.findCandidatesWithRelaxation({
            destinationId: request.destinationId,
            requestedStarRating,
            facilityIds: params.facilityIds,
        });
        const dbHotels = relaxResult.candidates;
        const relaxationBanner = (0, searchRelaxation_1.describeRelaxation)(relaxResult.appliedLevel);
        const usedDifferentDestination = relaxResult.usedDestinationId !== request.destinationId;
        let destinationFallbackInfo = null;
        if (usedDifferentDestination && dbHotels.length > 0) {
            const [origName, usedName] = await Promise.all([
                hotelSearch_repository_1.default.getDestinationName(request.destinationId),
                hotelSearch_repository_1.default.getDestinationName(relaxResult.usedDestinationId),
            ]);
            destinationFallbackInfo = {
                originalDestinationId: request.destinationId,
                originalDestinationName: origName ?? (request.destinationName ?? ''),
                usedDestinationId: relaxResult.usedDestinationId,
                usedDestinationName: usedName ?? '',
                bannerMessage: (0, searchRelaxation_1.describeDestinationFallback)(dbHotels.length, origName ?? (request.destinationName ?? 'the requested area'), usedName ?? 'a wider area'),
            };
        }
        if (relaxResult.appliedLevel !== 'exact' &&
            relaxResult.appliedLevel !== 'star_pm1') {
            await (0, audit_1.logAuditEvent)({
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
            logger_1.default.warn({ requestId, destinationId: request.destinationId }, 'Auto-offer: no hotels at any relaxation level or fallback destination');
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
        const primaryHotelCodes = new Set(requestedStarRating == null
            ? dbHotels.map((h) => h.hotelCode)
            : dbHotels
                .filter((h) => {
                const s = h.starRating ? Number(h.starRating) : null;
                return s !== null && Math.abs(requestedStarRating - s) < 0.5;
            })
                .map((h) => h.hotelCode));
        const sortedHotels = [
            ...dbHotels.filter((h) => primaryHotelCodes.has(h.hotelCode)),
            ...dbHotels.filter((h) => !primaryHotelCodes.has(h.hotelCode)),
        ];
        // Clean up old probe jobs from previous searches for this request
        await hotelProbeJob_repository_1.default.deleteBySearchRequest(requestId);
        const roomTypeTargets = buildRoomTypeTargets(request.rooms);
        const probeLimit = roomTypeTargets.reduce((s, t) => s + t.probeLimit, 0) || totalRooms * probeConfig_1.PROBE_MULTIPLIER;
        let jobsQueued = 0;
        // Drop probe-time mealType filter when relaxation reached meal_dropped+
        const RELAXED_PAST_MEAL_AUTO = new Set([
            'meal_dropped',
            'location_dropped',
            'facilities_dropped',
        ]);
        const probeMealType = RELAXED_PAST_MEAL_AUTO.has(relaxResult.appliedLevel)
            ? undefined
            : params.mealType;
        for (const dbHotel of sortedHotels) {
            const jobId = (0, crypto_1.randomUUID)();
            await hotelProbeJob_repository_1.default.create({
                id: jobId,
                searchRequestId: requestId,
                hotelCode: dbHotel.hotelCode,
                requestedRooms: totalRooms,
                probeLimit,
            });
            await (0, hotelProbe_publisher_1.publishHotelProbeJob)({
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
        logger_1.default.info({
            requestId,
            totalCandidates: dbHotels.length,
            jobsQueued,
            appliedLevel: relaxResult.appliedLevel,
            usedDestinationId: relaxResult.usedDestinationId,
        }, 'Auto-offer probe jobs queued');
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
    calculateSellPrice(buyingPrice, markupPercent = 18) {
        const raw = buyingPrice * (1 + markupPercent / 100);
        const rounded = Math.ceil(raw);
        let psychPrice = rounded;
        if (rounded % 10 === 0)
            psychPrice = rounded - 2; // €200 → €198
        else if (rounded % 5 === 0)
            psychPrice = rounded - 1; // €195 → €194
        return { buyingPrice, sellPrice: psychPrice, markupPercent };
    }
}
exports.HotelSearchService = HotelSearchService;
exports.default = new HotelSearchService();
