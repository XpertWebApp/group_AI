import { getChannel, HOTEL_PROBE_QUEUE } from './rabbitmq.client';
import { HotelProbeJobPayload, HotelProbeCompletedEvent, HotelProbeProgressEvent, ExpandedRoom } from './hotelProbeJob.types';
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
    } = payload;

    logger.info({ jobId, hotelCode, requestedRooms, probeLimit }, 'Processing HotelProbeJob');

    await hotelProbeJobRepository.setRunning(jobId);

    // ── Probe loop ────────────────────────────────────────────────────────────
    const allOptions: any[] = [];
    let roomsFound = 0;
    let lastProbeRange = '';
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
            // Hotel returned no data for this probe — no more capacity
            logger.info({ jobId, hotelCode, lastProbeRange }, 'No hotel entry in probe response — stopping probes');
            break;
        }

        const rawOptions: any[] = field<any[]>(wbeHotel, 'Options', 'options') ?? [];
        const batchOptions = parseProbeOptions(rawOptions, nights, PROBE_BATCH_SIZE);

        // Apply meal type filter
        const mealFiltered = mealType
            ? batchOptions.filter((o) => o.mealType?.toUpperCase() === mealType.toUpperCase())
            : batchOptions;

        // Apply room type filter
        const roomTypeFiltered = mealFiltered.filter((o) =>
            matchesRoomType(o.roomDescriptions, dominantRoomType),
        );

        if (roomTypeFiltered.length === 0) {
            // No usable options in this batch — hotel exhausted
            logger.info({ jobId, hotelCode, lastProbeRange }, 'No usable options in probe — stopping probes');
            break;
        }

        // Count rooms this batch confirmed — number of distinct options × batch size rooms supported
        // Each successful probe response indicates PROBE_BATCH_SIZE rooms are available at this hotel
        roomsFound += PROBE_BATCH_SIZE;
        allOptions.push(...roomTypeFiltered);

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
            message: `Probed ${lastProbeRange}: found ${roomsFound} rooms so far`,
        };
        broadcast(searchRequestId, 'hotelProbeProgress', progressEvent);

        logger.info({ jobId, hotelCode, lastProbeRange, roomsFound }, 'Probe batch complete');

        // Early stop — already found enough rooms
        if (roomsFound >= probeLimit) break;
    }

    // ── Capacity evaluation ───────────────────────────────────────────────────
    let capacityStatus: 'CONFIRMED' | 'LIMITED' | 'INSUFFICIENT';
    let capacityVerificationRequired = false;
    let reason: string | undefined;

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

    // ── Run filter pipeline + supplier split on aggregated options ────────────
    const dedupedOptions = deduplicateBySupplier(allOptions);
    const prices = dedupedOptions.map((o) => o.pricePerRoomPerNight);
    const midPrices = selectMidRange(prices);
    const selectedOptions = dedupedOptions.filter((o) => midPrices.includes(o.pricePerRoomPerNight));
    const optionsForSplit = selectedOptions.length > 0 ? selectedOptions : dedupedOptions;
    const highestMidRangePrice = midPrices.length > 0 ? Math.max(...midPrices) : 0;

    // ── Step 3.1 — Hotel Room Capacity Check ──────────────────────────────────
    // Calculate max_possible_from_hotel BEFORE building the split, to decide
    // whether this hotel can contribute meaningfully (>= 6 rooms).
    const MIN_MEANINGFUL_CONTRIBUTION = 6;
    const maxPossibleFromHotel = optionsForSplit.reduce(
        (sum, opt) => sum + getCappedMax(opt.supplierCode, requestedRooms),
        0,
    );
    const hotelContribution = Math.min(maxPossibleFromHotel, requestedRooms);

    if (hotelContribution < MIN_MEANINGFUL_CONTRIBUTION) {
        reason = `Hotel contribution ${hotelContribution} rooms (supplier caps) below minimum ${MIN_MEANINGFUL_CONTRIBUTION}.`;
        await hotelProbeJobRepository.skipInsufficient(jobId, roomsFound, reason);
        const completedEvent: HotelProbeCompletedEvent = {
            hotelCode,
            status: 'INSUFFICIENT',
            roomsFound,
            capacityVerificationRequired: false,
            reason,
        };
        broadcast(searchRequestId, 'hotelProbeCompleted', completedEvent);
        logger.info({ jobId, hotelCode, hotelContribution, maxPossibleFromHotel }, 'Hotel skipped — contribution below minimum');
        return;
    }

    const supplierSplit = buildSupplierSplit(optionsForSplit, requestedRooms, requestedRooms);

    // Actual rooms covered by the supplier split (may be less than requestedRooms due to supplier caps)
    const roomsAllocated = supplierSplit.reduce((s, o) => s + o.rooms, 0);
    if (roomsAllocated < requestedRooms) {
        capacityStatus = 'LIMITED';
        capacityVerificationRequired = true;
    }

    // Enrich with DB hotel info
    const dbHotelMap = await hotelSearchRepository.getHotelsByCode([hotelCode]);
    const dbHotel = dbHotelMap.get(hotelCode);

    const rawImageKey = dbHotel?.primaryImageKey ?? null;
    let imageUrl: string | null = null;
    if (rawImageKey) {
        let decodedKey = rawImageKey;
        try { decodedKey = decodeURIComponent(rawImageKey); } catch { /* use as-is */ }
        imageUrl = `/api/v1/hotels/image?key=${encodeURIComponent(decodedKey)}`;
    }

    // Calculate sell price
    const buyingPriceBase = highestMidRangePrice;
    const raw = buyingPriceBase * (1 + markupPercent / 100);
    const rounded = Math.ceil(raw);
    let sellingPrice = rounded;
    if (rounded % 10 === 0) sellingPrice = rounded - 2;
    else if (rounded % 5 === 0) sellingPrice = rounded - 1;

    const note = capacityVerificationRequired
        ? roomsAllocated < requestedRooms
            ? `Supplier caps limit allocation to ${roomsAllocated} of ${requestedRooms} requested rooms — verify additional supply with the hotel.`
            : 'Room availability equals requested amount — capacity should be verified with the hotel.'
        : undefined;

    const resultJson = {
        hotelCode,
        hotelName: dbHotel?.name ?? hotelCode,
        starRating: dbHotel?.starRating ? Number(dbHotel.starRating) : null,
        imageUrl,
        addressCity: dbHotel?.addressCity ?? null,
        addressCountry: dbHotel?.addressCountry ?? null,
        latitude: dbHotel?.latitude ? Number(dbHotel.latitude) : null,
        longitude: dbHotel?.longitude ? Number(dbHotel.longitude) : null,
        roomsFound,
        roomsAllocated,
        capacityStatus,
        capacityVerificationRequired,
        highestMidRangePrice,
        sellingPricePerRoomPerNight: sellingPrice,
        currency: dedupedOptions[0]?.currency ?? currencyCode,
        supplierSplit,
        usableOptions: dedupedOptions,
        selectedOptions,
        note,
    };

    await hotelProbeJobRepository.complete(jobId, resultJson);

    const completedEvent: HotelProbeCompletedEvent = {
        hotelCode,
        status: capacityStatus,
        roomsFound,
        capacityVerificationRequired,
        result: resultJson,
    };
    broadcast(searchRequestId, 'hotelProbeCompleted', completedEvent);

    logger.info(
        { jobId, hotelCode, roomsFound, capacityStatus, sellingPrice },
        'HotelProbeJob completed',
    );
}

// ─── Worker startup ───────────────────────────────────────────────────────────

export async function startHotelProbeWorker(): Promise<void> {
    const ch = await getChannel();

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
