import { getChannel, HOTEL_PROBE_QUEUE } from './rabbitmq.client';
import {
    HotelProbeJobPayload,
    HotelProbeCompletedEvent,
    HotelProbeProgressEvent,
    RoomTypeProbeProgress,
    ExpandedRoom,
} from './hotelProbeJob.types';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import wbeClientService from '../services/wbe.client.service';
import { broadcast } from '../services/sseManager';
import { getSupplierMaxRooms, isGroupAllowed, getCappedMax } from '../config/supplierLimits';
import logger from '../utils/logger';
import {
    PROBE_BATCH_SIZE,
    PROBE_WAIT_SECONDS,
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

function normalisePricePerRoomPerNight(rawPrice: number, nights: number, batchSize: number): number {
    if (!rawPrice || !nights || !batchSize) return 0;
    return rawPrice / (batchSize * nights);
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

function buildSupplierSplit(options: any[], targetRooms: number, totalRoomsNeeded: number) {
    const sorted = [...options].sort((a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight);
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

        result.push({
            tid,
            supplierCode,
            pricePerRoomPerNight: normalisePricePerRoomPerNight(rawPrice, nights, batchSize),
            rawTotalPrice: rawPrice,
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
    } = payload;

    logger.info({ jobId, hotelCode, requestedRooms, probeLimit, hasPerTypeTargets: !!roomTypeTargets }, 'Processing HotelProbeJob');

    await hotelProbeJobRepository.setRunning(jobId);

    // ── Probe loop ────────────────────────────────────────────────────────────
    const allOptions: any[] = [];
    let roomsFound = 0;
    let lastProbeRange = '';

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

        for (const target of roomTypeTargets) {
            const typeBatches = Math.ceil(target.probeLimit / PROBE_BATCH_SIZE);
            let typeRoomsFound = 0;

            logger.info(
                { jobId, hotelCode, roomType: target.roomType, requested: target.requested, probeLimit: target.probeLimit, batches: typeBatches },
                'Starting per-type probe phase',
            );

            for (let batch = 0; batch < typeBatches; batch++) {
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
                        Rooms: buildHomogeneousBatch(target.adults, target.children, target.childrenAges, startRoomId),
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

                if (!wbeHotel) {
                    logger.info({ jobId, hotelCode, roomType: target.roomType, lastProbeRange }, 'No hotel entry — stopping probes for this type');
                    break;
                }

                const rawOptions: any[] = field<any[]>(wbeHotel, 'Options', 'options') ?? [];
                const batchOptions = parseProbeOptions(rawOptions, nights, PROBE_BATCH_SIZE);

                // Apply meal type filter
                const mealFiltered = mealType
                    ? batchOptions.filter((o) => o.mealType?.toUpperCase() === mealType.toUpperCase())
                    : batchOptions;

                // Apply room type filter — use the specific type for this phase
                const roomTypeFiltered = mealFiltered.filter((o) =>
                    matchesRoomType(o.roomDescriptions, target.roomType),
                );

                if (roomTypeFiltered.length === 0) {
                    logger.info({ jobId, hotelCode, roomType: target.roomType, lastProbeRange }, 'No usable options — stopping probes for this type');
                    break;
                }

                // Tag options with roomType + sessionId for downstream use (Step 3.4 needs sessionId)
                for (const opt of roomTypeFiltered) {
                    opt.roomType = target.roomType;
                    opt.sessionId = sessionId;
                }

                typeRoomsFound += PROBE_BATCH_SIZE;
                roomsFound += PROBE_BATCH_SIZE;
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
            const found = typeProgressMap.get(target.roomType)?.roomsFound ?? 0;
            if (found < target.requested) {
                anyInsufficient = true;
                insufficientTypes.push(`${target.roomType}: found ${found}, need ${target.requested}`);
            } else if (found === target.requested) {
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
        hotelSearchRepository.getHotelsByCode([hotelCode]),
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

    console.log(`[Step 3.4] PASS ${hotelCode}: validatedRooms=${validatedRoomsAllocated}, suppliers=${validatedSplit.length}, earliestCxlDeadline=${earliestCxlDeadline}`);

    // ── Enrich with DB hotel info ────────────────────────────────────────────
    const rawImageKey = dbHotel?.primaryImageKey ?? null;
    let imageUrl: string | null = null;
    if (rawImageKey) {
        let decodedKey = rawImageKey;
        try { decodedKey = decodeURIComponent(rawImageKey); } catch { /* use as-is */ }
        imageUrl = `/api/v1/hotels/image?key=${encodeURIComponent(decodedKey)}`;
    }

    // Calculate sell price — uses HIGHEST mid-range price across ALL room types (Step 4.1)
    const buyingPriceBase = overallHighestMidRangePrice;
    const raw = buyingPriceBase * (1 + markupPercent / 100);
    const rounded = Math.ceil(raw);
    let sellingPrice = rounded;
    if (rounded % 10 === 0) sellingPrice = rounded - 2;
    else if (rounded % 5 === 0) sellingPrice = rounded - 1;

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
        return {
            roomType: type,
            requested: data.requested,
            roomsAllocated: validatedTypeRooms,
            highestMidRangePrice: data.highestMidRangePrice,
            supplierCount: validatedForType.length,
        };
    }).filter((t) => t.roomsAllocated > 0); // Only include types that have rooms

    console.log(`[EC3] Per-type allocations for ${hotelCode}:`);
    for (const t of perTypeAllocations) {
        console.log(`[EC3]   ${t.roomType}: ${t.roomsAllocated}/${t.requested} rooms, ${t.supplierCount} suppliers, highestMid=${t.highestMidRangePrice}`);
    }

    const resultJson = {
        hotelCode,
        hotelName: dbHotel?.name ?? hotelCode,
        starRating: dbHotel?.starRating ? Number(dbHotel.starRating) : null,
        imageUrl,
        description: dbHotel?.description ?? null,
        addressCity: dbHotel?.addressCity ?? null,
        addressCountry: dbHotel?.addressCountry ?? null,
        latitude: dbHotel?.latitude ? Number(dbHotel.latitude) : null,
        longitude: dbHotel?.longitude ? Number(dbHotel.longitude) : null,
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
        highestMidRangePrice: overallHighestMidRangePrice,
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
    const ch = await getChannel();

    if (!ch) {
        logger.warn('Hotel probe worker skipped — RabbitMQ not available');
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
