import { getChannel, HOTEL_PROBE_QUEUE, onReconnect } from './rabbitmq.client';
import {
    HotelProbeJobPayload,
    HotelProbeCompletedEvent,
    HotelProbeProgressEvent,
    RoomTypeProbeProgress,
    RoomTypeProbeTarget,
    ExpandedRoom,
} from './hotelProbeJob.types';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import wbeClientService from '../services/wbe.client.service';
import { broadcast } from '../services/sseManager';
import { getSupplierMaxRooms, isGroupAllowed, getCappedMax, getSupplierPriority, SUPPLIER_PRIORITY_RANK } from '../config/supplierLimits';
import { isYouthFriendlyName } from '../config/youthFriendlyPatterns';
import logger from '../utils/logger';
import { normalisePricePerRoomPerNight } from '../utils/pricing';
import { floorStarRating } from '../utils/starRating';
import {
    PROBE_BATCH_SIZE,
    PROBE_MULTIPLIER,
    PROBE_POLL_INTERVAL_MS,
    PROBE_POLL_TIMEOUT_MS,
    MULTI_SUPPLIER_OVERLAP_THRESHOLD,
    OVERLAP_DISCOUNT_FACTOR,
} from '../config/probeConfig';

// ─── Re-use filter helpers inline (avoid circular imports) ────────────────────

function field<T>(obj: any, ...keys: string[]): T | undefined {
    for (const k of keys) {
        if (obj != null && obj[k] !== undefined) return obj[k] as T;
    }
    return undefined;
}

function deduplicateBySupplier(options: any[]): any[] {
    const map = new Map<string, any>();
    for (const opt of options) {
        const existing = map.get(opt.supplierCode);
        if (!existing || opt.pricePerRoomPerNight < existing.pricePerRoomPerNight) {
            map.set(opt.supplierCode, opt);
        }
    }
    return Array.from(map.values());
}

function selectMidRange(prices: number[], trimPct = 20): number[] {
    if (prices.length === 0) return [];
    const sorted = [...prices].sort((a, b) => a - b);
    const cutLow = Math.floor((sorted.length * trimPct) / 100);
    const cutHigh = Math.ceil(sorted.length * (1 - trimPct / 100));
    return sorted.slice(cutLow, cutHigh);
}

function matchesRoomType(roomDescriptions: string[], requestedType: string | null): boolean {
    if (!requestedType) return true;
    if (roomDescriptions.length === 0) return true;
    const descs = roomDescriptions.map((d) => d.toLowerCase());
    const type = requestedType.toLowerCase();
    const acceptable = [type];
    if (type === 'single') acceptable.push('twin');
    if (type === 'double') acceptable.push('twin');
    if (type === 'triple') acceptable.push('quad');
    // New breakdown types: standardDoubleBeds → match "double"/"twin", twinBeds → match "twin"/"double"
    if (type === 'standarddoublebeds') { acceptable.push('double', 'twin'); }
    if (type === 'twinbeds') { acceptable.push('twin', 'double'); }
    return descs.some((d) => acceptable.some((kw) => d.includes(kw)));
}

/**
 * Exported so the group-booking service allocates rooms exactly the way the
 * probe did when the price was quoted. Re-deriving the split independently
 * would let the two drift, and the customer would be booked against an
 * allocation different from the one they were priced on.
 */
export function buildSupplierSplit(options: any[], targetRooms: number, totalRoomsNeeded: number) {
    // Priority-first, cheapest-first tie-break.
    //
    // Client rule (Oliver, 2026-07-XX): allocate from higher-priority
    // suppliers first, regardless of price. Within the same priority tier,
    // fall back to cheapest-first. AVOID suppliers are still eligible but
    // come last — they're only used if higher tiers can't fulfil the room.
    //
    // Priority tiers (see SUPPLIER_PRIORITY_RANK):
    //   HIGH   (0) — HyperGuest, Roibos
    //   MEDIUM (1) — Expedia, Sun Hotels, DOTW, etc.
    //   LOW    (2) — HotelBeds, GoGlobal, RoomsXML
    //   AVOID  (3) — TALE, Mideast, POW
    const sorted = [...options].sort((a, b) => {
        const rankA = SUPPLIER_PRIORITY_RANK[getSupplierPriority(a.supplierCode)];
        const rankB = SUPPLIER_PRIORITY_RANK[getSupplierPriority(b.supplierCode)];
        if (rankA !== rankB) return rankA - rankB;         // higher priority first
        return a.pricePerRoomPerNight - b.pricePerRoomPerNight; // then cheapest first
    });
    const split: any[] = [];
    let remaining = targetRooms;
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

// ─── Probe batch builder ──────────────────────────────────────────────────────

/**
 * Build the WBE Rooms array for a single probe batch.
 * startRoomId is 1-based. Rooms cycle through expandedRooms for composition.
 */
function buildProbeBatch(
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

/**
 * Build a homogeneous WBE Rooms array where all rooms have the same composition.
 * Used for per-room-type probing (all singles, all doubles, etc.).
 */
function buildHomogeneousBatch(
    adults: number,
    children: number,
    childrenAges: number[],
    startRoomId: number,
    batchSize: number = PROBE_BATCH_SIZE,
): Array<{ RoomID: number; AdultsNo: string; ChildrenNo: string; ChildrenAges: number[] }> {
    return Array.from({ length: batchSize }, (_, i) => ({
        RoomID: startRoomId + i,
        AdultsNo: String(adults),
        ChildrenNo: String(children),
        ChildrenAges: childrenAges,
    }));
}

// ─── WBE polling ─────────────────────────────────────────────────────────────

async function pollUntilFinished(sessionId: string): Promise<any[]> {
    const start = Date.now();
    const accumulated: any[] = [];
    while (Date.now() - start < PROBE_POLL_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, PROBE_POLL_INTERVAL_MS));
        try {
            const update = await wbeClientService.getUpdatedOptionsV2({ SessionID: sessionId });
            const hotels = field<any[]>(update, 'Data', 'data', 'Hotels', 'hotels') ?? [];
            accumulated.push(...hotels);
            if (field<boolean>(update, 'Finished', 'finished') ?? false) break;
        } catch {
            break;
        }
    }
    return accumulated;
}

// ─── Parse WBE options for a single probe batch ───────────────────────────────

function parseProbeOptions(wbeHotelOptions: any[], nights: number, batchSize: number): any[] {
    const result: any[] = [];
    for (const opt of wbeHotelOptions ?? []) {
        const tid = field<string>(opt, 'TID', 'Tid', 'tid');
        const rawPrice = field<number>(opt, 'TotalPrice', 'totalPrice', 'Price', 'price');
        if (!tid || rawPrice === undefined) continue;

        const supplierCode = field<string>(opt, 'SupplierCode', 'supplierCode', 'Supplier') ?? 'UNKNOWN';
        if (!isGroupAllowed(supplierCode)) continue;

        const freeCancellation = field<boolean>(opt, 'FreeCancellation', 'freeCancellation') ?? false;
        if (!freeCancellation) continue;

        const onRequest = field<boolean>(opt, 'OnRequest', 'onRequest') ?? false;
        if (onRequest) continue;

        const mealType = field<string>(opt, 'MealType', 'mealType', 'BoardType') ?? '';
        const mealName = field<string>(opt, 'MealName', 'mealName', 'BoardName') ?? '';
        const currency = field<string>(opt, 'Currency', 'currency', 'CurrencyCode') ?? 'EUR';
        const cancelDeadline = field<string>(opt, 'ClxDeadline', 'clxDeadline', 'CxlDeadline', 'cxlDeadline') ?? null;
        const providerPrice = field<number>(opt, 'ProviderPrice', 'providerPrice');
        const providerCurrency = field<string>(opt, 'ProviderCurrency', 'providerCurrency');
        const rawRooms: any[] = field<any[]>(opt, 'Rooms', 'rooms') ?? [];
        const roomDescriptions = rawRooms
            .map((r) => field<string>(r, 'Description', 'description', 'RoomName', 'roomName') ?? '')
            .filter(Boolean);

        // Divide by the ACTUAL number of rooms WBE returned in this option, not
        // the hardcoded batchSize. WBE may return options with fewer rooms than
        // requested (partial availability), and using batchSize in those cases
        // under-divides the price. Fall back to batchSize only if Rooms is empty.
        const roomsInOption = rawRooms.length > 0 ? rawRooms.length : batchSize;

        result.push({
            tid,
            supplierCode,
            pricePerRoomPerNight: normalisePricePerRoomPerNight(rawPrice, roomsInOption, nights, { tid, supplierCode }),
            rawTotalPrice: rawPrice,
            roomsInOption,
            currency,
            freeCancellation,
            onRequest,
            mealType,
            mealName,
            roomDescriptions,
            cancelDeadline,
            maxRoomsFromSupplier: getSupplierMaxRooms(supplierCode),
            providerPrice,
            providerCurrency,
        });
    }
    return result;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function processJob(payload: HotelProbeJobPayload): Promise<void> {
    const {
        jobId,
        searchRequestId,
        hotelCode,
        checkinDate,
        nights,
        requestedRooms,
        probeLimit,
        currencyCode,
        nationalityCode,
        waitSeconds,
        mealType,
        markupPercent,
        expandedRooms,
        dominantRoomType,
        roomTypeTargets,
        searchKind,
        alternativeReason,
        lang,
    } = payload;

    logger.info({ jobId, hotelCode, requestedRooms, probeLimit, hasPerTypeTargets: !!roomTypeTargets }, 'Processing HotelProbeJob');

    await hotelProbeJobRepository.setRunning(jobId);

    // ── Probe loop ────────────────────────────────────────────────────────────
    const allOptions: any[] = [];
    let roomsFound = 0;
    let lastProbeRange = '';

    // Capture hotel metadata from WBE responses as fallback when DB is missing it
    // (address, lat/lng etc). Used when dbHotel doesn't have this data populated.
    const wbeHotelMeta: {
        latitude?: number;
        longitude?: number;
        address?: string;
        hotelName?: string;
    } = {};
    const captureWbeHotelMeta = (h: any) => {
        if (!h) return;
        const lat = field<number>(h, 'Latitude', 'latitude');
        const lng = field<number>(h, 'Longitude', 'longitude');
        if (wbeHotelMeta.latitude === undefined && typeof lat === 'number' && lat !== 0) {
            wbeHotelMeta.latitude = Number(lat);
        }
        if (wbeHotelMeta.longitude === undefined && typeof lng === 'number' && lng !== 0) {
            wbeHotelMeta.longitude = Number(lng);
        }
        if (!wbeHotelMeta.address) {
            const addr = field<string>(h, 'Address', 'address');
            if (addr) wbeHotelMeta.address = String(addr);
        }
        if (!wbeHotelMeta.hotelName) {
            const name = field<string>(h, 'HotelName', 'hotelName', 'Name', 'name');
            if (name) wbeHotelMeta.hotelName = String(name);
        }
    };

    // Per-room-type progress tracking
    const typeProgressMap = new Map<string, RoomTypeProbeProgress>();

    if (roomTypeTargets && roomTypeTargets.length > 0) {
        // ── NEW: Per-room-type probing ────────────────────────────────────────
        for (const target of roomTypeTargets) {
            typeProgressMap.set(target.roomType, {
                roomType: target.roomType,
                requested: target.requested,
                probeLimit: target.probeLimit,
                roomsFound: 0,
            });
        }

        let globalRoomId = 1; // Running RoomID across all type phases
        const substituteTargets: RoomTypeProbeTarget[] = []; // Quadruple fallback targets added during probing

        for (const target of roomTypeTargets) {
            const typeBatches = Math.ceil(target.probeLimit / PROBE_BATCH_SIZE);
            let typeRoomsFound = 0;

            logger.info(
                { jobId, hotelCode, roomType: target.roomType, requested: target.requested, probeLimit: target.probeLimit, batches: typeBatches },
                'Starting per-type probe phase',
            );

            for (let batch = 0; batch < typeBatches; batch++) {
                // Calculate actual batch size (may be smaller than PROBE_BATCH_SIZE for the last batch or small requests)
                const remainingToProbe = target.probeLimit - typeRoomsFound;
                const actualBatchSize = Math.min(PROBE_BATCH_SIZE, remainingToProbe);

                const startRoomId = globalRoomId;
                const endRoomId = startRoomId + actualBatchSize - 1;
                lastProbeRange = `R${startRoomId}-R${endRoomId}`;
                globalRoomId += actualBatchSize;

                let wbeResult: any;
                try {
                    wbeResult = await wbeClientService.searchAndGetByHotelsV2({
                        HotelIds: [hotelCode],
                        CheckInDate: checkinDate,
                        Nights: nights,
                        WaitSeconds: waitSeconds,
                        CurrencyCode: currencyCode,
                        NationalityCode: nationalityCode,
                        Rooms: buildHomogeneousBatch(target.adults, target.children, target.childrenAges, startRoomId, actualBatchSize),
                    });
                } catch (err: any) {
                    logger.warn({ jobId, hotelCode, roomType: target.roomType, lastProbeRange, error: err.message }, 'WBE probe call failed');
                    break;
                }

                if (!wbeResult) break;

                const sessionId = field<string>(wbeResult, 'SessionID', 'sessionId', 'SessionId') ?? '';
                const isFinished = field<boolean>(wbeResult, 'Finished', 'finished') ?? true;
                let hotelEntries: any[] = field<any[]>(wbeResult, 'Data', 'data', 'Hotels', 'hotels') ?? [];

                if (!isFinished && sessionId) {
                    const polled = await pollUntilFinished(sessionId);
                    hotelEntries.push(...polled);
                }

                const wbeHotel = hotelEntries.find(
                    (h: any) => (field<string>(h, 'HotelCode', 'hotelCode', 'Code') ?? '') === hotelCode,
                );
                captureWbeHotelMeta(wbeHotel);

                if (!wbeHotel) {
                    logger.info({ jobId, hotelCode, roomType: target.roomType, lastProbeRange }, 'No hotel entry — stopping probes for this type');
                    break;
                }

                const rawOptions: any[] = field<any[]>(wbeHotel, 'Options', 'options') ?? [];
                const batchOptions = parseProbeOptions(rawOptions, nights, actualBatchSize);

                // Apply meal type filter
                const mealFiltered = mealType
                    ? batchOptions.filter((o) => o.mealType?.toUpperCase() === mealType.toUpperCase())
                    : batchOptions;

                // Apply room type filter — use the specific type for this phase
                const roomTypeFiltered = mealFiltered.filter((o) =>
                    matchesRoomType(o.roomDescriptions, target.roomType),
                );

                if (roomTypeFiltered.length === 0) {
                    logger.info({ jobId, hotelCode, roomType: target.roomType, lastProbeRange, totalRaw: rawOptions.length, afterParse: batchOptions.length, afterMeal: mealFiltered.length }, 'No usable options — stopping probes for this type');
                    break;
                }

                // Tag options with the requested roomType (for grouping/allocation) +
                // requestedRoomType (what the client asked for) + sessionId.
                // Preserve the ACTUAL WBE room description separately so the UI can
                // show the real room name (e.g. "Double Room, Terrace (1 Double Bed)")
                // instead of just "Single" — per M5 data-integrity requirement.
                for (const opt of roomTypeFiltered) {
                    opt.requestedRoomType = target.roomType;
                    opt.roomType = target.roomType;                       // kept for backwards compat (allocation logic)
                    opt.actualRoomDescription = opt.roomDescriptions?.[0] ?? null;
                    opt.sessionId = sessionId;
                }

                typeRoomsFound += actualBatchSize;
                roomsFound += actualBatchSize;
                allOptions.push(...roomTypeFiltered);

                // Update per-type progress
                const typeProgress = typeProgressMap.get(target.roomType)!;
                typeProgress.roomsFound = typeRoomsFound;

                // Build per-type summary for SSE message
                const typeProgressArray = Array.from(typeProgressMap.values());
                const progressSummary = typeProgressArray
                    .map((tp) => `${tp.roomsFound}/${tp.probeLimit} ${tp.roomType}s`)
                    .join(', ');

                // Persist partial state + emit progress
                await hotelProbeJobRepository.updateProbing(jobId, {
                    roomsFound,
                    lastProbeRange,
                    optionsSnapshot: allOptions,
                });

                const progressEvent: HotelProbeProgressEvent = {
                    hotelCode,
                    status: 'PROBING',
                    roomsFound,
                    lastProbeRange,
                    percentComplete: Math.min(100, Math.round((roomsFound / probeLimit) * 100)),
                    message: `Probing ${target.roomType} ${lastProbeRange}: ${progressSummary}`,
                    roomTypeProgress: typeProgressArray,
                };
                broadcast(searchRequestId, 'hotelProbeProgress', progressEvent);

                logger.info({ jobId, hotelCode, roomType: target.roomType, lastProbeRange, typeRoomsFound, roomsFound }, 'Probe batch complete');

                if (typeRoomsFound >= target.probeLimit) break;
            }

            logger.info(
                { jobId, hotelCode, roomType: target.roomType, typeRoomsFound, probeLimit: target.probeLimit },
                'Per-type probe phase finished',
            );

            // ── Quadruple fallback: if quads came up short, probe doubles (2 doubles = 1 quad).
            // Secondary fallback (2 twins) collapses into this phase because matchesRoomType('double', ...)
            // already accepts "twin" descriptions — doubles preferred, twins allowed.
            if (target.roomType === 'quadruple' && typeRoomsFound < target.requested) {
                const quadShortfall = target.requested - typeRoomsFound;
                const fallbackRoomsNeeded = quadShortfall * 2;
                const fallbackProbeLimit = fallbackRoomsNeeded * PROBE_MULTIPLIER;
                const fallbackBatches = Math.ceil(fallbackProbeLimit / PROBE_BATCH_SIZE);
                let fallbackRoomsFound = 0;

                const fallbackTarget: RoomTypeProbeTarget = {
                    roomType: 'quadruple__sub_double',
                    requested: fallbackRoomsNeeded,
                    probeLimit: fallbackProbeLimit,
                    adults: 2,
                    children: 0,
                    childrenAges: [],
                    substituteFor: 'quadruple',
                    substituteRatio: 2,
                    matchKeyword: 'double',
                };

                typeProgressMap.set('quadruple__sub_double', {
                    roomType: 'quadruple__sub_double',
                    requested: fallbackRoomsNeeded,
                    probeLimit: fallbackProbeLimit,
                    roomsFound: 0,
                    substituteFor: 'quadruple',
                    substituteRatio: 2,
                });

                logger.info(
                    { jobId, hotelCode, quadShortfall, fallbackRoomsNeeded, fallbackProbeLimit, fallbackBatches },
                    'Starting quadruple fallback probe (doubles, twin allowed)',
                );

                for (let fb = 0; fb < fallbackBatches; fb++) {
                    const startRoomId = globalRoomId;
                    const endRoomId = startRoomId + PROBE_BATCH_SIZE - 1;
                    lastProbeRange = `R${startRoomId}-R${endRoomId}`;
                    globalRoomId += PROBE_BATCH_SIZE;

                    let wbeResult: any;
                    try {
                        wbeResult = await wbeClientService.searchAndGetByHotelsV2({
                            HotelIds: [hotelCode],
                            CheckInDate: checkinDate,
                            Nights: nights,
                            WaitSeconds: waitSeconds,
                            CurrencyCode: currencyCode,
                            NationalityCode: nationalityCode,
                            Rooms: buildHomogeneousBatch(2, 0, [], startRoomId),
                        });
                    } catch (err: any) {
                        logger.warn({ jobId, hotelCode, lastProbeRange, error: err.message }, 'Quadruple fallback WBE call failed');
                        break;
                    }

                    if (!wbeResult) break;

                    const sessionId = field<string>(wbeResult, 'SessionID', 'sessionId', 'SessionId') ?? '';
                    const isFinished = field<boolean>(wbeResult, 'Finished', 'finished') ?? true;
                    let hotelEntries: any[] = field<any[]>(wbeResult, 'Data', 'data', 'Hotels', 'hotels') ?? [];

                    if (!isFinished && sessionId) {
                        const polled = await pollUntilFinished(sessionId);
                        hotelEntries.push(...polled);
                    }

                    const wbeHotel = hotelEntries.find(
                        (h: any) => (field<string>(h, 'HotelCode', 'hotelCode', 'Code') ?? '') === hotelCode,
                    );
                    captureWbeHotelMeta(wbeHotel);

                    if (!wbeHotel) {
                        logger.info({ jobId, hotelCode, lastProbeRange }, 'Quadruple fallback: no hotel entry — stopping');
                        break;
                    }

                    const rawOptions: any[] = field<any[]>(wbeHotel, 'Options', 'options') ?? [];
                    const batchOptions = parseProbeOptions(rawOptions, nights, PROBE_BATCH_SIZE);

                    const mealFiltered = mealType
                        ? batchOptions.filter((o) => o.mealType?.toUpperCase() === mealType.toUpperCase())
                        : batchOptions;

                    // matchesRoomType('double', ...) accepts double + twin — secondary "2 twins" fallback is subsumed here.
                    const roomTypeFiltered = mealFiltered.filter((o) =>
                        matchesRoomType(o.roomDescriptions, 'double'),
                    );

                    if (roomTypeFiltered.length === 0) {
                        logger.info({ jobId, hotelCode, lastProbeRange }, 'Quadruple fallback: no double/twin matches — stopping');
                        break;
                    }

                    // Tag as synthetic substitute type so EC3 allocation groups these separately
                    for (const opt of roomTypeFiltered) {
                        opt.requestedRoomType = 'quadruple';
                        opt.roomType = 'quadruple__sub_double';
                        opt.substituteFor = 'quadruple';
                        opt.substituteRatio = 2;
                        opt.actualRoomDescription = opt.roomDescriptions?.[0] ?? null;
                        opt.sessionId = sessionId;
                    }

                    fallbackRoomsFound += PROBE_BATCH_SIZE;
                    roomsFound += PROBE_BATCH_SIZE;
                    allOptions.push(...roomTypeFiltered);

                    const subProgress = typeProgressMap.get('quadruple__sub_double')!;
                    subProgress.roomsFound = fallbackRoomsFound;

                    const typeProgressArray = Array.from(typeProgressMap.values());
                    const progressSummary = typeProgressArray
                        .map((tp) => `${tp.roomsFound}/${tp.probeLimit} ${tp.roomType}s`)
                        .join(', ');

                    await hotelProbeJobRepository.updateProbing(jobId, {
                        roomsFound,
                        lastProbeRange,
                        optionsSnapshot: allOptions,
                    });

                    const progressEvent: HotelProbeProgressEvent = {
                        hotelCode,
                        status: 'PROBING',
                        roomsFound,
                        lastProbeRange,
                        percentComplete: Math.min(100, Math.round((roomsFound / probeLimit) * 100)),
                        message: `Probing quadruple fallback (double) ${lastProbeRange}: ${progressSummary}`,
                        roomTypeProgress: typeProgressArray,
                    };
                    broadcast(searchRequestId, 'hotelProbeProgress', progressEvent);

                    if (fallbackRoomsFound >= fallbackRoomsNeeded) break;
                }

                substituteTargets.push(fallbackTarget);

                logger.info(
                    { jobId, hotelCode, fallbackRoomsFound, fallbackRoomsNeeded },
                    'Quadruple fallback phase finished',
                );
            }
        }

        // Append substitute targets so the capacity check + EC3 allocation see them.
        // Done after the main per-type loop so the for-of above doesn't re-iterate them.
        if (substituteTargets.length > 0) {
            roomTypeTargets.push(...substituteTargets);
        }
    } else {
        // ── LEGACY: Aggregate probing (backward compat for old jobs) ──────────
        const maxBatches = Math.ceil(probeLimit / PROBE_BATCH_SIZE);

        for (let batch = 0; batch < maxBatches; batch++) {
            const startRoomId = batch * PROBE_BATCH_SIZE + 1;
            const endRoomId = startRoomId + PROBE_BATCH_SIZE - 1;
            lastProbeRange = `R${startRoomId}-R${endRoomId}`;

            let wbeResult: any;
            try {
                wbeResult = await wbeClientService.searchAndGetByHotelsV2({
                    HotelIds: [hotelCode],
                    CheckInDate: checkinDate,
                    Nights: nights,
                    WaitSeconds: waitSeconds,
                    CurrencyCode: currencyCode,
                    NationalityCode: nationalityCode,
                    Rooms: buildProbeBatch(expandedRooms, startRoomId),
                });
            } catch (err: any) {
                logger.warn({ jobId, hotelCode, lastProbeRange, error: err.message }, 'WBE probe call failed');
                break;
            }

            if (!wbeResult) break;

            const sessionId = field<string>(wbeResult, 'SessionID', 'sessionId', 'SessionId') ?? '';
            const isFinished = field<boolean>(wbeResult, 'Finished', 'finished') ?? true;
            let hotelEntries: any[] = field<any[]>(wbeResult, 'Data', 'data', 'Hotels', 'hotels') ?? [];

            if (!isFinished && sessionId) {
                const polled = await pollUntilFinished(sessionId);
                hotelEntries.push(...polled);
            }

            const wbeHotel = hotelEntries.find(
                (h: any) => (field<string>(h, 'HotelCode', 'hotelCode', 'Code') ?? '') === hotelCode,
            );
            captureWbeHotelMeta(wbeHotel);

            if (!wbeHotel) {
                logger.info({ jobId, hotelCode, lastProbeRange }, 'No hotel entry in probe response — stopping probes');
                break;
            }

            const rawOptions: any[] = field<any[]>(wbeHotel, 'Options', 'options') ?? [];
            const batchOptions = parseProbeOptions(rawOptions, nights, PROBE_BATCH_SIZE);

            const mealFiltered = mealType
                ? batchOptions.filter((o) => o.mealType?.toUpperCase() === mealType.toUpperCase())
                : batchOptions;

            const roomTypeFiltered = mealFiltered.filter((o) =>
                matchesRoomType(o.roomDescriptions, dominantRoomType),
            );

            if (roomTypeFiltered.length === 0) {
                logger.info({ jobId, hotelCode, lastProbeRange }, 'No usable options in probe — stopping probes');
                break;
            }

            // Tag options with sessionId for downstream use (Step 3.4 needs sessionId)
            for (const opt of roomTypeFiltered) {
                opt.sessionId = sessionId;
            }

            roomsFound += PROBE_BATCH_SIZE;
            allOptions.push(...roomTypeFiltered);

            await hotelProbeJobRepository.updateProbing(jobId, {
                roomsFound,
                lastProbeRange,
                optionsSnapshot: allOptions,
            });

            const progressEvent: HotelProbeProgressEvent = {
                hotelCode,
                status: 'PROBING',
                roomsFound,
                lastProbeRange,
                percentComplete: Math.min(100, Math.round((roomsFound / probeLimit) * 100)),
                message: `Probed ${lastProbeRange}: found ${roomsFound} rooms so far`,
            };
            broadcast(searchRequestId, 'hotelProbeProgress', progressEvent);

            logger.info({ jobId, hotelCode, lastProbeRange, roomsFound }, 'Probe batch complete');

            if (roomsFound >= probeLimit) break;
        }
    }

    // ── Capacity evaluation ───────────────────────────────────────────────────
    let capacityStatus: 'CONFIRMED' | 'LIMITED' | 'INSUFFICIENT';
    let capacityVerificationRequired = false;
    let reason: string | undefined;
    const typeProgressArray = Array.from(typeProgressMap.values());

    if (roomTypeTargets && roomTypeTargets.length > 0) {
        // Per-room-type capacity evaluation
        let allConfirmed = true;
        let anyInsufficient = false;
        const insufficientTypes: string[] = [];

        for (const target of roomTypeTargets) {
            // Substitute targets (e.g. quadruple__sub_double) are credited against their parent
            // type below — they don't stand on their own.
            if (target.substituteFor) continue;

            const found = typeProgressMap.get(target.roomType)?.roomsFound ?? 0;

            // Sum credits from any substitute targets that back this room type.
            // Each substitute room counts as 1/ratio of its parent type (2 doubles = 1 quad).
            const substituteCredit = roomTypeTargets
                .filter((t) => t.substituteFor === target.roomType)
                .reduce((sum, sub) => {
                    const subFound = typeProgressMap.get(sub.roomType)?.roomsFound ?? 0;
                    const ratio = sub.substituteRatio ?? 1;
                    return sum + Math.floor(subFound / ratio);
                }, 0);

            const effectiveFound = found + substituteCredit;

            if (effectiveFound < target.requested) {
                anyInsufficient = true;
                const detail = substituteCredit > 0
                    ? `found ${found} + ${substituteCredit} substitute`
                    : `found ${found}`;
                insufficientTypes.push(`${target.roomType}: ${detail}, need ${target.requested}`);
            } else if (effectiveFound === target.requested) {
                allConfirmed = false;
            }
        }

        if (anyInsufficient) {
            capacityStatus = 'INSUFFICIENT';
            reason = `Insufficient capacity per room type — ${insufficientTypes.join('; ')}.`;
            await hotelProbeJobRepository.skipInsufficient(jobId, roomsFound, reason);
            const completedEvent: HotelProbeCompletedEvent = {
                hotelCode,
                status: 'INSUFFICIENT',
                roomsFound,
                capacityVerificationRequired: false,
                reason,
                roomTypeProgress: typeProgressArray,
            };
            broadcast(searchRequestId, 'hotelProbeCompleted', completedEvent);
            logger.info({ jobId, hotelCode, roomsFound, requestedRooms, insufficientTypes }, 'Hotel skipped — insufficient per-type capacity');
            return;
        } else if (allConfirmed) {
            capacityStatus = 'CONFIRMED';
        } else {
            capacityStatus = 'LIMITED';
            capacityVerificationRequired = true;
        }
    } else {
        // Legacy aggregate evaluation
        if (roomsFound > requestedRooms) {
            capacityStatus = 'CONFIRMED';
        } else if (roomsFound === requestedRooms) {
            capacityStatus = 'LIMITED';
            capacityVerificationRequired = true;
        } else {
            capacityStatus = 'INSUFFICIENT';
            reason = `Only ${roomsFound} rooms found, ${requestedRooms} required.`;
            await hotelProbeJobRepository.skipInsufficient(jobId, roomsFound, reason);
            const completedEvent: HotelProbeCompletedEvent = {
                hotelCode,
                status: 'INSUFFICIENT',
                roomsFound,
                capacityVerificationRequired: false,
                reason,
            };
            broadcast(searchRequestId, 'hotelProbeCompleted', completedEvent);
            logger.info({ jobId, hotelCode, roomsFound, requestedRooms }, 'Hotel skipped — insufficient capacity');
            return;
        }
    }

    // ── Fetch DB hotel info (needed for Step 3.2 overlap check + enrichment) ──
    const [dbHotelMap, facilityMap] = await Promise.all([
        hotelSearchRepository.getHotelsByCode([hotelCode], lang === 'de' ? 'de' : 'en'),
        hotelSearchRepository.getFacilitiesByHotelCodes([hotelCode]),
    ]);
    const dbHotel = dbHotelMap.get(hotelCode);
    const hotelFacilities = facilityMap.get(hotelCode) ?? [];
    // For small requests (< 6 rooms), accept any hotel that covers at least 50% of the need.
    // For larger requests, keep the original floor of 6.
    const MIN_MEANINGFUL_CONTRIBUTION = Math.min(6, Math.max(1, Math.ceil(requestedRooms * 0.5)));

    // ══════════════════════════════════════════════════════════════════════════
    // EC3: Per-Room-Type Filter Pipeline + Supplier Splits
    // Group options by roomType → deduplicate → price band → supplier split per type
    // ══════════════════════════════════════════════════════════════════════════

    const optionsByType = new Map<string, any[]>();
    for (const opt of allOptions) {
        const type = opt.roomType ?? 'standard';
        if (!optionsByType.has(type)) optionsByType.set(type, []);
        optionsByType.get(type)!.push(opt);
    }

    console.log(`[EC3] ${hotelCode}: Grouped options into ${optionsByType.size} room type(s): ${[...optionsByType.keys()].join(', ')}`);

    interface PerTypeSplitData {
        roomType: string;
        requested: number;
        dedupedOptions: any[];
        midRangeOptions: any[];
        highestMidRangePrice: number;
        supplierSplit: any[];
        roomsAllocated: number;
    }
    const perTypeSplits: Record<string, PerTypeSplitData> = {};
    let overallHighestMidRangePrice = 0;
    let totalRoomsAllocatedAllTypes = 0;
    let overlapDetected = false;
    let totalRoomsUnverified = false;
    let totalSupplierClaim = 0;
    let effectiveCapacity = 0;
    let physicalCapacity = 0;

    const dbTotalRooms = dbHotel?.totalRooms ?? 0;
    if (dbTotalRooms === 0) {
        totalRoomsUnverified = true;
        console.log(`[Step 3.2] DB totalRooms unknown for ${hotelCode} — using probed capacity only`);
    }

    for (const [roomType, typeOptions] of optionsByType) {
        const target = roomTypeTargets?.find((t) => t.roomType === roomType);
        const typeRequested = target?.requested ?? typeOptions.length;

        console.log(`\n[EC3:${roomType}] Processing ${typeOptions.length} options, requested=${typeRequested}`);

        // Step 2.3 — Deduplicate by supplier (within this room type only)
        const deduped = deduplicateBySupplier(typeOptions);
        console.log(`[EC3:${roomType}] After dedup: ${deduped.length} unique suppliers`);

        // Step 2.4 — Price band filter
        const prices = deduped.map((o) => o.pricePerRoomPerNight);
        const midPrices = selectMidRange(prices);
        const selected = deduped.filter((o) => midPrices.includes(o.pricePerRoomPerNight));
        const optionsForSplit = selected.length > 0 ? selected : deduped;
        const highestMid = midPrices.length > 0 ? Math.max(...midPrices) : 0;

        if (highestMid > overallHighestMidRangePrice) overallHighestMidRangePrice = highestMid;

        console.log(`[EC3:${roomType}] Mid-range: ${optionsForSplit.length} options, highestMidPrice=${highestMid}`);

        // Step 3.1 — Capacity check per type
        const typeMaxPossible = optionsForSplit.reduce(
            (sum, opt) => sum + getCappedMax(opt.supplierCode, requestedRooms), 0,
        );
        const typeContribution = Math.min(typeMaxPossible, typeRequested);
        console.log(`[Step 3.1:${roomType}] maxPossible=${typeMaxPossible}, contribution=${typeContribution}, suppliers=${optionsForSplit.length}`);

        if (typeContribution === 0) {
            console.log(`[Step 3.1:${roomType}] SKIP — no capacity for this room type`);
            continue;
        }

        // Step 3.2 — Multi-supplier overlap heuristic
        const typeProbed = typeProgressMap.get(roomType)?.roomsFound ?? roomsFound;
        const supplierCount = optionsForSplit.length; // already deduped by supplier
        const typeSupplierClaim = optionsForSplit.reduce(
            (sum, opt) => sum + getCappedMax(opt.supplierCode, requestedRooms), 0,
        );

        let typeEffective: number;
        if (supplierCount <= 1) {
            // Single supplier — no overlap possible
            typeEffective = typeSupplierClaim;
            console.log(`[Step 3.2:${roomType}] Single supplier — no overlap. claim=${typeSupplierClaim}`);
        } else if (dbTotalRooms > 0) {
            // Verified DB capacity — use as authoritative ceiling
            const typePhysical = Math.min(typeProbed, dbTotalRooms);
            if (typeSupplierClaim > typePhysical) {
                overlapDetected = true;
                typeEffective = typePhysical;
                console.log(`[Step 3.2:${roomType}] VERIFIED OVERLAP: supplierClaim=${typeSupplierClaim} > dbCapacity=${typePhysical}, capped to ${typeEffective}`);
            } else {
                typeEffective = typeSupplierClaim;
                console.log(`[Step 3.2:${roomType}] No overlap (verified): supplierClaim=${typeSupplierClaim} <= dbCapacity=${typePhysical}`);
            }
        } else if (requestedRooms >= MULTI_SUPPLIER_OVERLAP_THRESHOLD) {
            // Large request, multiple suppliers, no verified count — apply overlap discount
            typeEffective = Math.floor(typeSupplierClaim * OVERLAP_DISCOUNT_FACTOR);
            overlapDetected = true;
            console.log(`[Step 3.2:${roomType}] OVERLAP RISK: ${supplierCount} suppliers, claim=${typeSupplierClaim}, discounted to ${typeEffective} (${OVERLAP_DISCOUNT_FACTOR * 100}%)`);
        } else {
            // Small/medium request, multiple suppliers — trust claims
            typeEffective = typeSupplierClaim;
            console.log(`[Step 3.2:${roomType}] Multiple suppliers (${supplierCount}), small request — trusting claim=${typeSupplierClaim}`);
        }

        totalSupplierClaim += typeSupplierClaim;
        effectiveCapacity += typeEffective;
        physicalCapacity += typeProbed;

        const typeEffectiveContribution = Math.min(typeEffective, typeRequested);

        // Step 3.3 — Build supplier split for this room type
        const typeSplit = buildSupplierSplit(optionsForSplit, typeEffectiveContribution, requestedRooms);
        const typeAllocated = typeSplit.reduce((s, e) => s + e.rooms, 0);

        // Tag each split entry with roomType
        for (const entry of typeSplit) {
            (entry as any).roomType = roomType;
        }

        console.log(`[Step 3.3:${roomType}] Split built: ${typeAllocated} rooms across ${typeSplit.length} suppliers`);
        for (const entry of typeSplit) {
            console.log(`[Step 3.3:${roomType}]   ${entry.supplierCode}: ${entry.rooms} rooms @ ${entry.pricePerRoomPerNight} ${entry.currency}`);
        }

        if (typeSplit.length < 2 && typeAllocated > 0) {
            console.log(`[Step 3.3:${roomType}] WARNING: only ${typeSplit.length} supplier(s) — Oliver prefers 2+`);
        }

        perTypeSplits[roomType] = {
            roomType,
            requested: typeRequested,
            dedupedOptions: deduped,
            midRangeOptions: optionsForSplit,
            highestMidRangePrice: highestMid,
            supplierSplit: typeSplit,
            roomsAllocated: typeAllocated,
        };

        totalRoomsAllocatedAllTypes += typeAllocated;
    }

    // ── Aggregate validation across all types ─────────────────────────────────
    const allTypeSplitEntries = Object.values(perTypeSplits).flatMap((t) => t.supplierSplit);

    console.log(`\n[Step 3.3] AGGREGATE ${hotelCode}: totalAllocated=${totalRoomsAllocatedAllTypes}, types=${Object.keys(perTypeSplits).length}, totalSplitEntries=${allTypeSplitEntries.length}`);
    logger.info({ jobId, hotelCode, totalRoomsAllocatedAllTypes, types: Object.keys(perTypeSplits) }, 'Step 3.3: Per-type splits complete');

    if (totalRoomsAllocatedAllTypes < MIN_MEANINGFUL_CONTRIBUTION) {
        reason = `Total rooms allocated across all types (${totalRoomsAllocatedAllTypes}) below minimum ${MIN_MEANINGFUL_CONTRIBUTION}.`;
        console.log(`[Step 3.3] SKIP ${hotelCode}: ${reason}`);
        await hotelProbeJobRepository.skipInsufficient(jobId, roomsFound, reason);
        const completedEvent: HotelProbeCompletedEvent = {
            hotelCode,
            status: 'INSUFFICIENT',
            roomsFound,
            capacityVerificationRequired: false,
            reason,
            roomTypeProgress: typeProgressArray.length > 0 ? typeProgressArray : undefined,
        };
        broadcast(searchRequestId, 'hotelProbeCompleted', completedEvent);
        return;
    }

    if (totalRoomsAllocatedAllTypes < requestedRooms) {
        capacityStatus = 'LIMITED';
        capacityVerificationRequired = true;
    }

    console.log(`[Step 3.3] PASS ${hotelCode}: totalAllocated=${totalRoomsAllocatedAllTypes}, capacityStatus=${capacityStatus}`);

    // ── Step 3.4 — Fetch Option Details per Supplier Entry ──────────────────
    // Call optionDetailsV2 for each entry in the supplier split to get exact
    // cancellation deadlines and per-night price breakdowns. If a call fails,
    // remove that supplier from the split. If remaining < 6, skip hotel.
    // Summary of entries per type for logging
    const typeEntrySummary = Object.entries(perTypeSplits).map(([t, d]) => `${d.supplierSplit.length} ${t}`).join(' + ');
    console.log(`[Step 3.4] Fetching option details for ${allTypeSplitEntries.length} entries (${typeEntrySummary}) of ${hotelCode}...`);
    logger.info({ jobId, hotelCode, splitEntries: allTypeSplitEntries.length }, 'Step 3.4: Starting option detail fetch');

    const validatedSplit: any[] = [];
    const cxlDeadlines: string[] = [];
    // WBE "Important Information" (check-in/out times, parking, etc.) from
    // OptionDetailsV2 DayPrices.EssentialInfo — collected so the card can show it.
    const essentialInfos: string[] = [];
    const OPTION_DETAIL_TTL_HOURS = 2;

    for (const entry of allTypeSplitEntries) {
        // Find the matching option to get sessionId (stored during probing)
        const matchingOption = allOptions.find((o) => o.tid === entry.tid);
        const entrySessionId = matchingOption?.sessionId ?? '';

        if (!entrySessionId) {
            console.log(`[Step 3.4] ⚠️  ${entry.supplierCode}: No sessionId for TID ${entry.tid} — removing from split`);
            logger.warn({ jobId, hotelCode, supplierCode: entry.supplierCode, tid: entry.tid }, 'Step 3.4: No sessionId — cannot fetch details');
            continue;
        }

        try {
            console.log(`[Step 3.4] Calling optionDetailsV2 for ${entry.supplierCode} (TID: ${entry.tid})...`);
            const detailRaw = await wbeClientService.optionDetailsV2({
                SessionID: entrySessionId,
                TID: entry.tid,
                HotelCode: hotelCode,
            });

            const detailData = detailRaw?.Data ?? detailRaw?.data ?? {};
            const cxlPolicy = detailData?.CxlPolicy ?? detailData?.cxlPolicy ?? {};
            const dayPricesObj = detailData?.DayPrices ?? detailData?.dayPrices ?? {};
            const cxlSuccess = cxlPolicy?.Success ?? cxlPolicy?.success ?? false;
            const daySuccess = dayPricesObj?.Success ?? dayPricesObj?.success ?? false;

            console.log(`[Step 3.4] ${entry.supplierCode}: CxlPolicy.Success=${cxlSuccess}, DayPrices.Success=${daySuccess}`);

            // Check NonRefundable — skip entry if it turned non-refundable
            const nonRefundable = field<boolean>(cxlPolicy, 'NonRefundable', 'nonRefundable') ?? false;
            if (nonRefundable) {
                console.log(`[Step 3.4] ❌ ${entry.supplierCode}: NonRefundable=true — removing from split`);
                logger.info({ jobId, hotelCode, supplierCode: entry.supplierCode, tid: entry.tid }, 'Step 3.4: Option is non-refundable — removed');
                continue;
            }

            // Extract cancellation deadline (OptionDate = date by which booking may be cancelled free)
            const optionDate = field<string>(cxlPolicy, 'OptionDate', 'optionDate') ?? null;
            if (optionDate) {
                cxlDeadlines.push(optionDate);
            }

            // Extract cancellation conditions
            const rawConditions: any[] = field<any[]>(cxlPolicy, 'Conditions', 'conditions') ?? [];
            const cxlComment = field<string>(cxlPolicy, 'Comment', 'comment') ?? undefined;
            const cxlRemarks = field<any>(cxlPolicy, 'Remarks', 'remarks') ?? undefined;

            // Extract validated total price from DayPrices
            const detailTotalPrice = field<number>(dayPricesObj, 'TotalPrice', 'totalPrice');
            const detailCurrency = field<string>(dayPricesObj, 'Currency', 'currency') ?? entry.currency;
            const detailMealType = field<string>(dayPricesObj, 'MealType', 'mealType');
            const detailMealName = field<string>(dayPricesObj, 'MealName', 'mealName');
            const essentialInfo = field<string>(dayPricesObj, 'EssentialInfo', 'essentialInfo') ?? undefined;
            if (essentialInfo && essentialInfo.trim()) essentialInfos.push(essentialInfo.trim());
            const supplements = field<any[]>(dayPricesObj, 'Supplements', 'supplements') ?? undefined;
            const detailProviderPrice = field<number>(dayPricesObj, 'ProviderPrice', 'providerPrice');
            const detailProviderCurrency = field<string>(dayPricesObj, 'ProviderCurrency', 'providerCurrency');
            const detailSupplierCode = field<string>(dayPricesObj, 'SupplierCode', 'supplierCode') ?? entry.supplierCode;

            // Extract per-room per-day breakdown
            const detailRooms: any[] = field<any[]>(dayPricesObj, 'Rooms', 'rooms') ?? [];
            const roomBreakdown = detailRooms.map((r) => ({
                roomId: field<number>(r, 'RoomId', 'roomId', 'RoomID') ?? 0,
                description: field<string>(r, 'Description', 'description', 'RoomName') ?? '',
                prices: (field<any[]>(r, 'Prices', 'prices') ?? []).map((p) => ({
                    date: field<string>(p, 'Date', 'date') ?? '',
                    price: field<number>(p, 'Price', 'price') ?? 0,
                })),
            }));

            // Enrich the supplier split entry with detail data
            entry.detailTotalPrice = detailTotalPrice ?? entry.rawTotalPrice;
            entry.cxlDeadline = optionDate;
            entry.cxlConditions = rawConditions;
            entry.roomBreakdown = roomBreakdown;

            // Recompute per-room-per-night from the AUTHORITATIVE OptionDetailsV2 total.
            // WBE search can return a bogus-low rawTotalPrice; OptionDetailsV2 reflects the
            // real booking total. Use detail.Rooms.length as the divisor (not allocated
            // rooms, which is a different concept).
            const detailRoomsCount = roomBreakdown.length > 0 ? roomBreakdown.length : (entry.roomsInOption ?? 1);
            if (detailTotalPrice && detailRoomsCount > 0 && nights > 0) {
                entry.detailPricePerRoomPerNight = detailTotalPrice / (detailRoomsCount * nights);

                // Log when search vs detail diverge by >30% — useful to spot WBE data
                // inconsistencies like the one Oliver's team reported on Bella Sky.
                const searchPPRPN = entry.pricePerRoomPerNight ?? 0;
                if (searchPPRPN > 0) {
                    const ratio = entry.detailPricePerRoomPerNight / searchPPRPN;
                    if (ratio > 1.3 || ratio < 0.77) {
                        logger.warn(
                            {
                                hotelCode, tid: entry.tid, supplierCode: entry.supplierCode,
                                searchPPRPN, detailPPRPN: entry.detailPricePerRoomPerNight,
                                searchTotal: entry.rawTotalPrice, detailTotal: detailTotalPrice,
                                detailRoomsCount, nights,
                            },
                            'Step 3.4: Search vs OptionDetails price divergence detected — trusting OptionDetails',
                        );
                    }
                }
            }

            validatedSplit.push(entry);

            console.log(`[Step 3.4] ✅ ${entry.supplierCode}: cxlDeadline=${optionDate}, totalPrice=${detailTotalPrice}, rooms=${entry.rooms}`);
            logger.info({
                jobId, hotelCode, supplierCode: entry.supplierCode, tid: entry.tid,
                cxlDeadline: optionDate, detailTotalPrice, rooms: entry.rooms,
            }, 'Step 3.4: Option detail fetched successfully');

            // Cache to DB (fire-and-forget — don't block the pipeline)
            const expiresAt = new Date(Date.now() + OPTION_DETAIL_TTL_HOURS * 60 * 60 * 1000);
            hotelSearchRepository.upsertOptionDetail({
                tid: entry.tid,
                hotelCode,
                data: detailRaw,
                nonRefundable,
                cxlOptionDate: optionDate ? new Date(optionDate) : undefined,
                cxlConditions: rawConditions,
                cxlComment,
                cxlRemarks,
                daypricesTotal: detailTotalPrice,
                daypricesCurrency: detailCurrency,
                mealType: detailMealType,
                mealName: detailMealName,
                providerPrice: detailProviderPrice,
                providerCurrency: detailProviderCurrency,
                supplierCode: detailSupplierCode,
                essentialInfo,
                supplements,
                rooms: roomBreakdown,
                success: cxlSuccess && daySuccess,
                expiresAt,
            }).catch((cacheErr: any) => {
                logger.warn({ jobId, hotelCode, tid: entry.tid, error: cacheErr.message }, 'Step 3.4: Failed to cache option detail');
            });

        } catch (err: any) {
            console.log(`[Step 3.4] ❌ ${entry.supplierCode}: FAILED — ${err.message} — removing from split`);
            logger.warn({
                jobId, hotelCode, supplierCode: entry.supplierCode, tid: entry.tid, error: err.message,
            }, 'Step 3.4: optionDetailsV2 call failed — removing supplier from split');
            // Entry NOT added to validatedSplit → effectively removed
        }
    }

    // Re-validate after removals
    const validatedRoomsAllocated = validatedSplit.reduce((s: number, e: any) => s + e.rooms, 0);
    const removedCount = allTypeSplitEntries.length - validatedSplit.length;
    console.log(`[Step 3.4] After detail fetch: ${validatedSplit.length}/${allTypeSplitEntries.length} suppliers remain, ${validatedRoomsAllocated} rooms allocated (${removedCount} removed)`);
    logger.info({
        jobId, hotelCode, validatedSuppliers: validatedSplit.length, originalSuppliers: allTypeSplitEntries.length,
        validatedRoomsAllocated, removedCount,
    }, 'Step 3.4: Option detail fetch complete');

    if (validatedRoomsAllocated < MIN_MEANINGFUL_CONTRIBUTION) {
        reason = `After option detail fetch: only ${validatedRoomsAllocated} rooms remain (${removedCount} suppliers failed/removed), below minimum ${MIN_MEANINGFUL_CONTRIBUTION}.`;
        console.log(`[Step 3.4] SKIP ${hotelCode}: ${reason}`);
        await hotelProbeJobRepository.skipInsufficient(jobId, roomsFound, reason);
        const completedEvent: HotelProbeCompletedEvent = {
            hotelCode,
            status: 'INSUFFICIENT',
            roomsFound,
            capacityVerificationRequired: false,
            reason,
            roomTypeProgress: typeProgressArray.length > 0 ? typeProgressArray : undefined,
        };
        broadcast(searchRequestId, 'hotelProbeCompleted', completedEvent);
        logger.info({ jobId, hotelCode, validatedRoomsAllocated, removedCount }, 'Step 3.4: Hotel skipped — too few rooms after detail validation');
        return;
    }

    // Update capacity status if validated allocation changed
    if (validatedRoomsAllocated < requestedRooms) {
        capacityStatus = 'LIMITED';
        capacityVerificationRequired = true;
    }

    // Earliest cancellation deadline = most restrictive (protects client)
    const earliestCxlDeadline = cxlDeadlines.length > 0
        ? cxlDeadlines.sort()[0]  // ISO strings sort chronologically
        : null;

    // First supplier's "Important Information" (check-in/out, parking, …) for the card.
    const firstEssentialInfo = essentialInfos.find(Boolean) ?? null;

    console.log(`[Step 3.4] PASS ${hotelCode}: validatedRooms=${validatedRoomsAllocated}, suppliers=${validatedSplit.length}, earliestCxlDeadline=${earliestCxlDeadline}`);

    // ── Enrich with DB hotel info ────────────────────────────────────────────
    // Build a fallback chain of image URLs so the FE can walk to the next one
    // when the proxy returns 404 / blank bytes. Priority:
    //   1. All GIATA categorised images (exterior → room → lobby → …).
    //   2. All WBE imageKeys ordered by displayOrder, wrapped in our proxy.
    // The first entry is the "primary" — exposed as the legacy `imageUrl`
    // field for backwards compatibility; `imageUrls` is the new full list.
    const wbeImageUrls = (dbHotel?.allImageKeys ?? []).map((key) => {
        let decoded = key;
        try { decoded = decodeURIComponent(key); } catch { /* use as-is */ }
        return `/api/v1/hotels/image?key=${encodeURIComponent(decoded)}`;
    });
    const imageUrls: string[] = [...(dbHotel?.giataImageUrls ?? []), ...wbeImageUrls];
    const imageUrl: string | null = imageUrls[0] ?? null;
    const imageSource: 'giata' | 'wbe' | 'none' =
        (dbHotel?.giataImageUrls?.length ?? 0) > 0
            ? 'giata'
            : wbeImageUrls.length > 0
                ? 'wbe'
                : 'none';
    logger.debug({ hotelCode, imageSource, total: imageUrls.length }, 'Primary image source');

    // Calculate sell price — uses HIGHEST mid-range price across ALL room types (Step 4.1)
    // Prefer OptionDetailsV2-derived prices (authoritative) over search prices (WBE
    // sometimes returns bogus-low rawTotalPrice in search that doesn't match the real
    // booking total — see Oliver's M* pricing issue).
    const detailPPRPNs: number[] = validatedSplit
        .map((e: any) => e.detailPricePerRoomPerNight)
        .filter((p: any) => typeof p === 'number' && p > 0);
    const buyingPriceBase = detailPPRPNs.length > 0
        ? Math.max(...detailPPRPNs)
        : overallHighestMidRangePrice;
    const raw = buyingPriceBase * (1 + markupPercent / 100);
    const rounded = Math.ceil(raw);
    let sellingPrice = rounded;
    if (rounded % 10 === 0) sellingPrice = rounded - 2;
    else if (rounded % 5 === 0) sellingPrice = rounded - 1;

    // ── Per-room-type sell prices (2026-07-14 client request) ─────────────
    // "The system should calculate separate selling prices for each room
    // type based on that room type's supplier prices." — we compute a full
    // calculation trail per row (net → raw → ceil → psychology → sell)
    // right here so downstream consumers (FE search card, FE calculation
    // panel, "add to proposal" flow) can display and reuse it without
    // re-deriving.
    //
    // Rule matches the hotel-level formula above exactly, applied per row:
    //   raw   = net × (1 + markup% / 100)
    //   ceil  = Math.ceil(raw)
    //   psych = -2 if ceil%10==0, -1 if ceil%5==0, 0 otherwise
    //   sell  = ceil + psych
    //
    // We MUTATE validatedSplit in place, adding two fields per entry:
    //   sellPricePerRoomPerNight: number
    //   sellCalculation: { buyingPrice, markupPercent, raw, ceil, psychAdjustment, sellPrice }
    //
    // The mutation is safe here because validatedSplit is a locally-built
    // array not yet written anywhere. Nothing downstream depends on the
    // narrower shape.
    for (const entry of validatedSplit as any[]) {
        const netForType = typeof entry.detailPricePerRoomPerNight === 'number' && entry.detailPricePerRoomPerNight > 0
            ? entry.detailPricePerRoomPerNight
            : (typeof entry.pricePerRoomPerNight === 'number' ? entry.pricePerRoomPerNight : 0);
        if (netForType <= 0) continue;
        const rawEntry = netForType * (1 + markupPercent / 100);
        const ceilEntry = Math.ceil(rawEntry);
        let psychEntry = 0;
        if (ceilEntry % 10 === 0) psychEntry = -2;
        else if (ceilEntry % 5 === 0) psychEntry = -1;
        const sellEntry = ceilEntry + psychEntry;
        entry.sellPricePerRoomPerNight = sellEntry;
        entry.sellCalculation = {
            buyingPrice: netForType,
            markupPercent,
            raw: rawEntry,
            ceil: ceilEntry,
            psychAdjustment: psychEntry,
            sellPrice: sellEntry,
        };
    }

    // Build note with overlap/unverified context
    const noteLines: string[] = [];
    if (overlapDetected) {
        if (dbTotalRooms > 0) {
            noteLines.push(`Inventory overlap detected — supplier claims (${totalSupplierClaim}) exceed verified hotel capacity (${dbTotalRooms}). Effective capacity capped to ${effectiveCapacity}.`);
        } else {
            // Count unique suppliers across all type splits
            const uniqueSuppliers = new Set(
                Object.values(perTypeSplits).flatMap((t) => t.supplierSplit.map((s: any) => s.supplierCode)),
            );
            noteLines.push(`Multiple suppliers found (${uniqueSuppliers.size}) — allocation reduced by ${Math.round((1 - OVERLAP_DISCOUNT_FACTOR) * 100)}% to account for potential inventory overlap across channels. Verify total capacity with hotel directly.`);
        }
    }
    if (totalRoomsUnverified && requestedRooms >= MULTI_SUPPLIER_OVERLAP_THRESHOLD) {
        noteLines.push(`Total room count unverified — confirm with hotel directly.`);
    }
    if (removedCount > 0) {
        noteLines.push(`${removedCount} supplier(s) removed during option detail validation — ${validatedSplit.length} remain.`);
    }
    if (capacityVerificationRequired) {
        if (validatedRoomsAllocated < requestedRooms) {
            noteLines.push(`Supplier caps limit allocation to ${validatedRoomsAllocated} of ${requestedRooms} requested rooms — verify additional supply with the hotel.`);
        } else {
            noteLines.push('Room availability equals requested amount — capacity should be verified with the hotel.');
        }
    }
    const note = noteLines.length > 0 ? noteLines.join(' ') : undefined;

    // Build per-type allocation summary for downstream (offer generation + PDF)
    const perTypeAllocations = Object.entries(perTypeSplits).map(([type, data]) => {
        // Count validated rooms for this type (some suppliers may have been removed in Step 3.4)
        const validatedForType = validatedSplit.filter((e: any) => e.roomType === type);
        const validatedTypeRooms = validatedForType.reduce((s: number, e: any) => s + e.rooms, 0);

        // M5 — Collect the ACTUAL WBE room descriptions for this type so the UI can
        // show the real room name (e.g. "Double Room, Terrace (1 Double Bed)") instead
        // of just the requested type label (e.g. "Single"). Deduplicate and cap to 5.
        const actualDescriptions = Array.from(new Set(
            (optionsByType.get(type) ?? [])
                .map((o: any) => o.actualRoomDescription ?? o.roomDescriptions?.[0])
                .filter(Boolean),
        )).slice(0, 5);

        // Rate basis — pick from the cheapest mid-range option for this room type,
        // fallback to any option for this type. Default "RO" (Room Only) when absent.
        const sourceOption =
            data.midRangeOptions?.[0] ??
            (optionsByType.get(type) ?? [])[0];
        const mealType = sourceOption?.mealType?.toString().trim() || 'RO';
        const mealName = sourceOption?.mealName?.toString().trim() || 'Room only';

        // Prefer validated OptionDetails prices over search-time prices for this type
        const typeDetailPPRPNs = validatedForType
            .map((e: any) => e.detailPricePerRoomPerNight)
            .filter((p: any) => typeof p === 'number' && p > 0);
        const highestMidRangePrice = typeDetailPPRPNs.length > 0
            ? Math.max(...typeDetailPPRPNs)
            : data.highestMidRangePrice;

        // Substitution metadata — carried from the synthetic target (e.g. quadruple__sub_double).
        // The source is the first option in the group since all options in a synthetic type share
        // the same substituteFor/substituteRatio tags.
        const firstOption = (optionsByType.get(type) ?? [])[0];
        const substituteFor = firstOption?.substituteFor as string | undefined;
        const substituteRatio = firstOption?.substituteRatio as number | undefined;
        const substituteUnitsCovered = substituteFor && substituteRatio
            ? Math.floor(validatedTypeRooms / substituteRatio)
            : undefined;
        const substitutionNote = substituteFor && substituteUnitsCovered
            ? `In place of ${substituteUnitsCovered} ${substituteFor} room${substituteUnitsCovered === 1 ? '' : 's'}`
            : undefined;

        return {
            roomType: type,
            requested: data.requested,
            roomsAllocated: validatedTypeRooms,
            highestMidRangePrice,
            supplierCount: validatedForType.length,
            actualDescriptions,
            mealType,
            mealName,
            substituteFor,
            substituteRatio,
            substituteUnitsCovered,
            substitutionNote,
        };
    }).filter((t) => t.roomsAllocated > 0); // Only include types that have rooms

    console.log(`[EC3] Per-type allocations for ${hotelCode}:`);
    for (const t of perTypeAllocations) {
        console.log(`[EC3]   ${t.roomType}: ${t.roomsAllocated}/${t.requested} rooms, ${t.supplierCount} suppliers, highestMid=${t.highestMidRangePrice}`);
    }

    const resultJson = {
        hotelCode,
        // 'main' = exact-criteria search; 'alternative' = relaxed-criteria search.
        // FE filters by this to render two sections ("Matching your request" vs
        // "Similar alternatives"). Defaults to 'main' for legacy probes.
        searchKind: searchKind ?? 'main',
        alternativeReason: alternativeReason ?? null,
        hotelName: dbHotel?.name ?? wbeHotelMeta.hotelName ?? hotelCode,
        // Soft ranking signal — true when the hotel's name matches any of
        // the multilingual youth-friendly patterns (hostel, Jugendherberge,
        // auberge, ostello, etc). Consumed by the accumulation gate to
        // promote these hotels for Youth/School group requests. Never used
        // as a filter — all hotels still flow through to the proposal.
        youthFriendly: isYouthFriendlyName(dbHotel?.name ?? wbeHotelMeta.hotelName ?? ''),
        starRating: floorStarRating(dbHotel?.starRating ? Number(dbHotel.starRating) : null),
        imageUrl,
        // Ordered fallback chain — FE renders the first URL and `onerror`s
        // down the list until one loads. Always non-empty when imageUrl is
        // set; empty array when the hotel has no images at all.
        imageUrls,
        // Public SETTHub detail page URL — frontend wraps the hotel name in a
        // link to open it (Oliver's "no duplicate detail page, just link out" ask).
        // Null when masterHotelId isn't synced yet — frontend renders plain text.
        sethubDetailsUrl: dbHotel?.sethubDetailsUrl ?? null,
        description: dbHotel?.description ?? null,
        descriptionLanguage: dbHotel?.descriptionLanguage ?? null,
        descriptionSource: dbHotel?.descriptionSource ?? null,
        // Both EN/DE translations in one payload — lets the FE swap card text
        // instantly on language toggle without re-running the search.
        descriptions: (dbHotel as any)?.descriptions ?? null,
        address: (dbHotel as any)?.address ?? wbeHotelMeta.address ?? null,
        addressCity: dbHotel?.addressCity ?? null,
        addressCountry: dbHotel?.addressCountry ?? null,
        latitude: dbHotel?.latitude ? Number(dbHotel.latitude) : (wbeHotelMeta.latitude ?? null),
        longitude: dbHotel?.longitude ? Number(dbHotel.longitude) : (wbeHotelMeta.longitude ?? null),
        roomsFound,
        roomsAllocated: validatedRoomsAllocated,
        capacityStatus,
        capacityVerificationRequired,
        overlapDetected,
        totalRoomsUnverified,
        effectiveCapacity,
        totalSupplierClaim,
        physicalCapacity,
        cxlDeadline: earliestCxlDeadline,
        essentialInfo: firstEssentialInfo,
        highestMidRangePrice: buyingPriceBase,
        sellingPricePerRoomPerNight: sellingPrice,
        currency: allOptions[0]?.currency ?? currencyCode,
        supplierSplit: validatedSplit,
        perTypeAllocations,
        facilities: hotelFacilities,
        note,
        roomTypeProgress: typeProgressArray.length > 0 ? typeProgressArray : undefined,
    };

    await hotelProbeJobRepository.complete(jobId, resultJson);

    const completedEvent: HotelProbeCompletedEvent = {
        hotelCode,
        status: capacityStatus,
        roomsFound,
        capacityVerificationRequired,
        result: resultJson,
        roomTypeProgress: typeProgressArray.length > 0 ? typeProgressArray : undefined,
    };
    broadcast(searchRequestId, 'hotelProbeCompleted', completedEvent);

    logger.info(
        { jobId, hotelCode, roomsFound, capacityStatus, sellingPrice, roomTypeProgress: typeProgressArray },
        'HotelProbeJob completed',
    );
}

// ─── Worker startup ───────────────────────────────────────────────────────────

export async function startHotelProbeWorker(): Promise<void> {
    // Register the consumer setup as a reconnect callback FIRST so any
    // future channel drop triggers auto-recovery. The callback is a
    // no-op if the channel isn't ready yet — that's fine, the initial
    // registerConsumer() call below handles the boot path.
    onReconnect(registerConsumer);

    // Initial boot registration. If this fails (RabbitMQ genuinely down at
    // boot), the reconnect loop in rabbitmq.client will keep retrying and
    // re-run our callback once it succeeds.
    await registerConsumer();
}

/**
 * Wire the ch.consume() handler on the current channel. Called once at
 * boot AND on every successful reconnect (via the onReconnect callback
 * registered above). Must be idempotent — calling it multiple times on
 * the SAME channel would double-consume every message, but each call
 * gets a fresh channel so that's fine in practice.
 */
async function registerConsumer(): Promise<void> {
    const ch = await getChannel();

    if (!ch) {
        logger.warn('Hotel probe worker skipped — RabbitMQ not available (will retry on reconnect)');
        return;
    }

    logger.info('Hotel probe worker started — waiting for jobs');

    ch.consume(
        HOTEL_PROBE_QUEUE,
        async (msg) => {
            if (!msg) return;

            let payload: HotelProbeJobPayload;
            try {
                payload = JSON.parse(msg.content.toString());
            } catch (err: any) {
                logger.error({ error: err.message }, 'Failed to parse HotelProbeJob message — dead-lettering');
                ch.nack(msg, false, false);
                return;
            }

            try {
                await processJob(payload);
                ch.ack(msg);
            } catch (err: any) {
                logger.error({ jobId: payload.jobId, hotelCode: payload.hotelCode, error: err.message }, 'HotelProbeJob failed');
                try {
                    await hotelProbeJobRepository.fail(payload.jobId, err.message ?? 'Unknown error');
                    broadcast(payload.searchRequestId, 'hotelProbeCompleted', {
                        hotelCode: payload.hotelCode,
                        status: 'FAILED',
                        roomsFound: 0,
                        capacityVerificationRequired: false,
                        reason: err.message,
                    } satisfies HotelProbeCompletedEvent);
                } catch { /* ignore secondary failure */ }
                ch.nack(msg, false, false); // discard — don't requeue to avoid infinite loop
            }
        },
        { noAck: false },
    );
}
