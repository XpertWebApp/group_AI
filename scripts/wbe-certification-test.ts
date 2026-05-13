/**
 * SmartKonnect / WBE Certification Test Runner
 *
 * Runs the WBE certification scenarios from `SmartKonnect Certification Test
 * scenarios.docx` that are compatible with our current adult-only room model.
 * Scenarios involving children (1, 2, 4, 5, 8, 9, 11, 12) are skipped — our
 * booking system does not yet support per-room child composition.
 *
 * Usage:
 *   ts-node scripts/wbe-certification-test.ts
 *
 * Output:
 *   - scripts/output/wbe-cert-<scenario>.json   — full request + response per scenario
 *   - scripts/output/wbe-cert-summary.json      — top-line pass/fail per scenario
 *   - Console log with one line per scenario
 *
 * Methodology:
 *   1. Pick a UAT destination with healthy inventory (Rome, 3172 hotels).
 *   2. Pull the first ~100 hotel codes from master.hotels at that destination.
 *   3. For each scenario:
 *        a. Build the WBE Rooms array matching the per-room adult occupancy.
 *        b. Call SearchAndGetByHotelsV2 once.
 *        c. Poll GetUpdatedOptions until Finished=true (or 60s cap).
 *        d. Pick one returned option (first hotel, first option) and call
 *           optionDetailsV2 for the full pricing/cancellation deadline.
 *   4. Save raw request + response payloads to disk for the certification submission.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import path from 'path';
import wbeClientService from '../src/services/wbe.client.service';

const prisma = new PrismaClient();

// ── Test destination ─────────────────────────────────────────────────────────
const DESTINATION_NAME = 'Rome';
const DESTINATION_ID = 1842893;
const HOTEL_BATCH_SIZE = 100;             // hotels per WBE search call
const MAX_BATCHES_PER_SCENARIO = 5;       // iterate up to this many batches until we find inventory
const CHECKIN_DATE = '2026-08-15';        // 3 months out — safe for UAT inventory
const CURRENCY_CODE = 'EUR';
const NATIONALITY_CODE = 'HU';            // matches our usual default
const WAIT_SECONDS = 45;                  // WBE wait param
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60_000;

// ── Scenario definitions (only the ones we can run today) ────────────────────
interface ScenarioRoom {
    adults: number;
    children: number;
    childrenAges: number[];
}
interface Scenario {
    id: number;
    description: string;
    mealType?: 'RO' | 'BB' | undefined;     // undefined = any
    nights: number;
    rooms: ScenarioRoom[];
}

const SCENARIOS: Scenario[] = [
    {
        id: 3,
        description: '1 room: 1 adult — Room Only, 4 nights',
        mealType: 'RO',
        nights: 4,
        rooms: [{ adults: 1, children: 0, childrenAges: [] }],
    },
    {
        id: 6,
        description: '1 room: 3 adults — Any meal, 10 nights',
        mealType: undefined,
        nights: 10,
        rooms: [{ adults: 3, children: 0, childrenAges: [] }],
    },
    {
        id: 7,
        description: '2 rooms: 2 adults / 2 adults — Room Only, 2 nights',
        mealType: 'RO',
        nights: 2,
        rooms: [
            { adults: 2, children: 0, childrenAges: [] },
            { adults: 2, children: 0, childrenAges: [] },
        ],
    },
    {
        id: 10,
        description: '2 rooms: 3 adults / 4 adults — Any meal, 4 nights',
        mealType: undefined,
        nights: 4,
        rooms: [
            { adults: 3, children: 0, childrenAges: [] },
            { adults: 4, children: 0, childrenAges: [] },
        ],
    },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function buildWbeRoomsArray(rooms: ScenarioRoom[]): Array<{
    RoomID: number;
    AdultsNo: string;
    ChildrenNo: string;
    ChildrenAges: number[];
}> {
    return rooms.map((r, idx) => ({
        RoomID: idx + 1,
        AdultsNo: String(r.adults),
        ChildrenNo: String(r.children),
        ChildrenAges: r.childrenAges,
    }));
}

async function pickHotelCodes(limit: number, offset: number = 0): Promise<string[]> {
    const rows = await prisma.hotel.findMany({
        where: { destinationId: DESTINATION_ID },
        select: { hotelCode: true },
        orderBy: [{ totalRooms: { sort: 'desc', nulls: 'last' } }, { hotelCode: 'asc' }],
        take: limit,
        skip: offset,
    });
    return rows.map((r) => r.hotelCode);
}

async function pollUntilFinished(sessionId: string): Promise<any[]> {
    const start = Date.now();
    const accumulated: any[] = [];
    while (Date.now() - start < POLL_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const update = await wbeClientService.getUpdatedOptionsV2({ SessionID: sessionId });
            const hotels = update?.Data?.Hotels ?? update?.data?.hotels ?? [];
            accumulated.push(...hotels);
            const finished = update?.Finished ?? update?.finished ?? false;
            if (finished) break;
        } catch (err: any) {
            console.error(`  poll error: ${err.message}`);
            break;
        }
    }
    return accumulated;
}

async function runScenario(scenario: Scenario) {
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`▸ Scenario ${scenario.id}: ${scenario.description}`);
    console.log(`══════════════════════════════════════════════════════════════════════`);

    // Iterate hotel batches until we find one that returns inventory (or hit the cap).
    let hotels: any[] = [];
    let sessionId: string | null = null;
    let initiallyFinished = false;
    let searchMs = 0;
    let searchRequest: any = null;
    let totalHotelsSearched = 0;
    let batchesRun = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_SCENARIO; batch++) {
        const offset = batch * HOTEL_BATCH_SIZE;
        const hotelCodes = await pickHotelCodes(HOTEL_BATCH_SIZE, offset);
        if (hotelCodes.length === 0) break;
        batchesRun++;
        totalHotelsSearched += hotelCodes.length;

        searchRequest = {
            HotelIds: hotelCodes,
            CheckInDate: CHECKIN_DATE,
            Nights: scenario.nights,
            WaitSeconds: WAIT_SECONDS,
            CurrencyCode: CURRENCY_CODE,
            NationalityCode: NATIONALITY_CODE,
            Rooms: buildWbeRoomsArray(scenario.rooms),
        };

        console.log(`  [batch ${batch + 1}/${MAX_BATCHES_PER_SCENARIO}] → SearchAndGetByHotelsV2 (HotelIds: ${hotelCodes.length}, Rooms: ${searchRequest.Rooms.length}, Nights: ${scenario.nights}, Offset: ${offset})`);
        const t0 = Date.now();
        let searchResponse: any;
        try {
            searchResponse = await wbeClientService.searchAndGetByHotelsV2(searchRequest);
        } catch (err: any) {
            console.error(`  ✗ SearchAndGetByHotelsV2 FAILED: ${err.message}`);
            return {
                scenarioId: scenario.id,
                ok: false,
                stage: 'search',
                error: err.message,
                searchRequest,
            };
        }
        searchMs += Date.now() - t0;
        sessionId = searchResponse?.SessionID ?? searchResponse?.sessionId ?? null;
        initiallyFinished = searchResponse?.Finished ?? searchResponse?.finished ?? false;
        let batchHotels = searchResponse?.Data?.Hotels ?? searchResponse?.data?.hotels ?? [];

        console.log(`           ← (${Date.now() - t0}ms) SessionID: ${sessionId ?? 'NONE'}, Finished: ${initiallyFinished}, Hotels: ${batchHotels.length}`);

        if (!initiallyFinished && sessionId) {
            const polled = await pollUntilFinished(sessionId);
            batchHotels = batchHotels.concat(polled);
            console.log(`           ← polling settled, batch hotels total: ${batchHotels.length}`);
        }

        hotels = hotels.concat(batchHotels);
        if (batchHotels.length > 0) break; // first batch with inventory wins
    }

    // Apply meal filter (some scenarios specify RO only; others accept any)
    const optionsByHotel = hotels.map((h: any) => ({
        hotelCode: h.HotelCode ?? h.hotelCode ?? h.Code,
        hotelName: h.HotelName ?? h.hotelName ?? h.Name,
        options: (h.Options ?? h.options ?? []).filter((o: any) => {
            if (!scenario.mealType) return true;
            const mt = (o.MealType ?? o.mealType ?? '').toUpperCase();
            return mt === scenario.mealType.toUpperCase();
        }),
    }));
    const totalOptionsAfterMealFilter = optionsByHotel.reduce((s: number, h: any) => s + h.options.length, 0);
    const hotelsWithOptions = optionsByHotel.filter((h: any) => h.options.length > 0);
    console.log(`  Filter (mealType=${scenario.mealType ?? 'any'}): ${hotelsWithOptions.length} hotels with ${totalOptionsAfterMealFilter} usable options`);

    // Pick one option and call OptionDetailsV2 (proves we can drill into pricing)
    let optionDetailsResponse: any = null;
    let pickedHotel: any = null;
    let pickedOption: any = null;
    if (hotelsWithOptions.length > 0 && sessionId) {
        pickedHotel = hotelsWithOptions[0];
        pickedOption = pickedHotel.options[0];
        const tid = pickedOption.TID ?? pickedOption.Tid ?? pickedOption.tid;
        const hc = pickedHotel.hotelCode;
        console.log(`  → OptionDetailsV2 (Hotel: ${pickedHotel.hotelName ?? hc}, TID: ${tid})`);
        try {
            optionDetailsResponse = await wbeClientService.optionDetailsV2({
                SessionID: sessionId,
                TID: tid,
                HotelCode: hc,
            });
            const total = optionDetailsResponse?.Data?.TotalPrice ?? optionDetailsResponse?.TotalPrice ?? '?';
            const cxl  = optionDetailsResponse?.Data?.CxlDeadline ?? optionDetailsResponse?.CxlDeadline ?? '?';
            console.log(`  ← OptionDetailsV2 OK — TotalPrice: ${total}, CxlDeadline: ${cxl}`);
        } catch (err: any) {
            console.error(`  ✗ OptionDetailsV2 FAILED: ${err.message}`);
            optionDetailsResponse = { error: err.message };
        }
    } else {
        console.log(`  (no usable options to drill into — skipping OptionDetailsV2)`);
    }

    return {
        scenarioId: scenario.id,
        description: scenario.description,
        ok: hotelsWithOptions.length > 0,
        stage: 'complete',
        searchRequest,
        searchResponseMeta: {
            sessionId,
            initiallyFinished,
            hotelsReturned: hotels.length,
            hotelsWithOptionsAfterMealFilter: hotelsWithOptions.length,
            totalOptionsAfterMealFilter,
            searchDurationMs: searchMs,
            batchesRun,
            totalHotelsSearched,
        },
        optionPicked: pickedHotel
            ? {
                  hotelCode: pickedHotel.hotelCode,
                  hotelName: pickedHotel.hotelName,
                  tid: pickedOption?.TID ?? pickedOption?.Tid ?? pickedOption?.tid,
                  mealType: pickedOption?.MealType ?? pickedOption?.mealType,
                  totalPrice: pickedOption?.TotalPrice ?? pickedOption?.totalPrice,
                  supplierCode: pickedOption?.SupplierCode ?? pickedOption?.supplierCode,
              }
            : null,
        optionDetailsResponse,
        // Cap size when persisting to keep the file readable
        hotelsSample: hotels.slice(0, 3),
    };
}

async function main() {
    console.log(`╔══════════════════════════════════════════════════════════════════════╗`);
    console.log(`║         SmartKonnect / WBE UAT Certification Test Run                ║`);
    console.log(`╚══════════════════════════════════════════════════════════════════════╝`);
    console.log(`Destination:  ${DESTINATION_NAME} (id=${DESTINATION_ID})`);
    console.log(`Check-in:     ${CHECKIN_DATE}`);
    console.log(`Scenarios:    ${SCENARIOS.map((s) => `#${s.id}`).join(', ')}`);
    console.log(`Skipped:      #1, #2, #4, #5, #8, #9, #11, #12 (require per-room children, not yet implemented)`);

    const outDir = path.join(process.cwd(), 'scripts', 'output');
    await fs.mkdir(outDir, { recursive: true });

    console.log(`Per-scenario will iterate up to ${MAX_BATCHES_PER_SCENARIO} batches × ${HOTEL_BATCH_SIZE} hotels (max ${MAX_BATCHES_PER_SCENARIO * HOTEL_BATCH_SIZE}) until inventory is found.`);

    const summary: any[] = [];
    for (const scenario of SCENARIOS) {
        try {
            const result = await runScenario(scenario);
            await fs.writeFile(
                path.join(outDir, `wbe-cert-scenario-${scenario.id}.json`),
                JSON.stringify(result, null, 2),
                'utf-8',
            );
            summary.push({
                scenarioId: scenario.id,
                description: scenario.description,
                ok: result.ok,
                hotelsWithOptions: result.searchResponseMeta?.hotelsWithOptionsAfterMealFilter ?? 0,
                totalOptions: result.searchResponseMeta?.totalOptionsAfterMealFilter ?? 0,
                searchDurationMs: result.searchResponseMeta?.searchDurationMs ?? null,
            });
        } catch (err: any) {
            console.error(`  ✗ Scenario ${scenario.id} CRASHED: ${err.message}`);
            summary.push({
                scenarioId: scenario.id,
                description: scenario.description,
                ok: false,
                error: err.message,
            });
        }
    }

    await fs.writeFile(
        path.join(outDir, 'wbe-cert-summary.json'),
        JSON.stringify({ destination: DESTINATION_NAME, destinationId: DESTINATION_ID, checkinDate: CHECKIN_DATE, summary }, null, 2),
        'utf-8',
    );

    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`                            SUMMARY`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    for (const s of summary) {
        const mark = s.ok ? '✅' : '✗ ';
        console.log(`${mark} Scenario ${s.scenarioId}: ${s.description}`);
        if (s.ok) {
            console.log(`     hotels: ${s.hotelsWithOptions}, options: ${s.totalOptions}, search ${s.searchDurationMs}ms`);
        } else {
            console.log(`     error: ${s.error ?? '(no usable options returned)'}`);
        }
    }
    console.log(`\nOutput dir: ${outDir}`);

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error('Fatal:', err);
    await prisma.$disconnect();
    process.exit(1);
});
