/**
 * WBE SmartKonnect XMLOUT certification runner.
 *
 * Executes the 14 certification scenarios end to end and records the booking
 * reference each one produces, which is the only artefact WBE asks for.
 *
 * Flow per scenario:
 *   search → (GetUpdatedOptions if flagged) → OptionDetailsV2(Prebook=false)
 *          → persist draft → prebook(Prebook=true) → [BookV2] → [cancel]
 *
 * Safety model
 * ------------
 * Booking is OFF unless --book is passed. Without it the runner still exercises
 * search, option details and prebook — enough to validate the integration —
 * but never creates a reservation or consumes credit.
 *
 * Scenarios 13 and 14 are Nonrefundable: WBE vouchers them immediately and they
 * cannot be cancelled without charge. They are skipped unless
 * --allow-nonrefundable is ALSO passed, and that flag should only be used with
 * written client approval.
 *
 * Refundable bookings are cancelled automatically once their reference has been
 * captured, because a confirmed booking left open is charged at its deadline.
 *
 * Usage:
 *   npx tsx scripts/certification/run.ts                        # dry run (default)
 *   npx tsx scripts/certification/run.ts --book                 # real bookings, refundable only
 *   npx tsx scripts/certification/run.ts --book --allow-nonrefundable
 *   npx tsx scripts/certification/run.ts --scenarios 1,3,7      # subset
 *   npx tsx scripts/certification/run.ts --no-cancel            # keep bookings open
 *
 * Output:
 *   scripts/output/certification/scenario-<n>.json  — full payloads per scenario
 *   scripts/output/certification/summary.json       — references for the PDF
 *   scripts/output/certification/summary.md         — table to paste into the doc
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

import certificationSearchService, {
    CertificationOption,
} from '../../src/services/certificationSearch.service';
import wbeBookingService, { BookingFlowError } from '../../src/services/wbeBooking.service';
import wbeClientService from '../../src/services/wbe.client.service';
import bookingRepository, {
    CreateBookingRoomData,
    CreateBookingPassengerData,
} from '../../src/repositories/booking.repository';
import {
    CERTIFICATION_SCENARIOS,
    CertificationScenario,
} from './scenarios';
import * as cfg from './config';

const prisma = new PrismaClient();

// ── CLI ──────────────────────────────────────────────────────────────────────

interface RunOptions {
    book: boolean;
    allowNonRefundable: boolean;
    cancelAfter: boolean;
    scenarioIds: number[] | null;
}

function parseArgs(argv: string[]): RunOptions {
    const has = (flag: string) => argv.includes(flag);

    const scenarioArg = argv.find((a) => a.startsWith('--scenarios'));
    let scenarioIds: number[] | null = null;
    if (scenarioArg) {
        const raw = scenarioArg.includes('=')
            ? scenarioArg.split('=')[1]
            : argv[argv.indexOf(scenarioArg) + 1];
        scenarioIds = (raw ?? '')
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= 14);
        if (scenarioIds.length === 0) scenarioIds = null;
    }

    return {
        book: has('--book') || cfg.BOOKING_ENABLED,
        allowNonRefundable: has('--allow-nonrefundable') || cfg.ALLOW_NONREFUNDABLE,
        cancelAfter: !has('--no-cancel') && cfg.AUTO_CANCEL_AFTER_BOOKING,
        scenarioIds,
    };
}

// ── Console helpers ──────────────────────────────────────────────────────────

const log = {
    step: (m: string) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`),
    ok: (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
    warn: (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`),
    fail: (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`),
    info: (m: string) => console.log(`    ${m}`),
};

// ── Result shape ─────────────────────────────────────────────────────────────

interface ScenarioResult {
    scenarioId: number;
    description: string;
    status: 'booked' | 'prebooked' | 'skipped' | 'failed';
    destination?: string;
    hotelName?: string;
    hotelCode?: string;
    /** The artefact WBE's certification document asks for. */
    bookingReference?: string | null;
    agencyReference?: string;
    wbeStatus?: string | null;
    quotedPrice?: number;
    prebookPrice?: number;
    priceChanged?: boolean;
    currency?: string;
    nonRefundable?: boolean | null;
    cancelledAfterwards?: boolean;
    optionsFound?: number;
    error?: string;
    durationMs: number;
}

// ── Passenger generation ─────────────────────────────────────────────────────

/**
 * Build a passenger manifest matching a scenario's occupancy.
 *
 * Adults deliberately carry no `age`: WBE requires the attribute to be absent
 * for adults, and sending 0 is a rejection rather than a no-op.
 */
function buildRooms(scenario: CertificationScenario): CreateBookingRoomData[] {
    let adultIdx = 0;
    let childIdx = 0;

    return scenario.rooms.map((room, i) => {
        const passengers: CreateBookingPassengerData[] = [];

        for (let a = 0; a < room.adults; a++) {
            const first = cfg.ADULT_FIRST_NAMES[adultIdx % cfg.ADULT_FIRST_NAMES.length];
            passengers.push({
                salutation: a % 2 === 0 ? 'Mr' : 'Mrs',
                firstName: first!,
                lastName: cfg.PASSENGER_LAST_NAME,
                isChild: false,
                // Exactly one leader across the whole booking.
                isLeader: i === 0 && a === 0,
            });
            adultIdx++;
        }

        for (const age of room.childrenAges ?? []) {
            const first = cfg.CHILD_FIRST_NAMES[childIdx % cfg.CHILD_FIRST_NAMES.length];
            passengers.push({
                salutation: 'Chd',
                firstName: first!,
                lastName: cfg.PASSENGER_LAST_NAME,
                isChild: true,
                age,
            });
            childIdx++;
        }

        return {
            roomId: i + 1,
            adultsNo: room.adults,
            childrenNo: room.childrenAges?.length ?? 0,
            passengers,
        };
    });
}

// ── Dates ────────────────────────────────────────────────────────────────────

function checkInDate(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + cfg.CHECKIN_DAYS_AHEAD);
    return d.toISOString().slice(0, 10);
}

function addNights(iso: string, nights: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + nights);
    return d.toISOString().slice(0, 10);
}

// ── Search with destination fallback ─────────────────────────────────────────

/**
 * Search each candidate destination until one yields options.
 *
 * UAT suppliers answer inconsistently, so a destination returning nothing is
 * expected rather than a failure — WBE says as much in the certification notes.
 * Only exhausting every candidate counts as a real miss.
 */
async function searchWithFallback(scenario: CertificationScenario, checkIn: string) {
    for (const dest of cfg.DESTINATION_CANDIDATES) {
        try {
            const result = await certificationSearchService.search({
                destinationId: dest.id,
                hotelLimit: cfg.HOTEL_BATCH_SIZE,
                checkInDate: checkIn,
                nights: scenario.nights,
                rooms: scenario.rooms,
                mealType: scenario.mealType,
                currencyCode: cfg.CURRENCY_CODE,
                nationalityCode: cfg.NATIONALITY_CODE,
                waitSeconds: cfg.SEARCH_WAIT_SECONDS,
            });

            if (result.totalOptions > 0) {
                log.ok(`${dest.name}: ${result.totalOptions} option(s) across ${result.hotels.length} hotel(s)`);
                return { result, destination: dest };
            }
            log.info(`${dest.name}: no options, trying next destination`);
        } catch (err: any) {
            log.warn(`${dest.name}: search failed — ${err.message}`);
        }
    }
    return null;
}

/**
 * Choose an option to book.
 *
 * Prefers an instantly confirmable option: OnRequest options produce a pending
 * reservation that may never confirm, which is of no use as a certification
 * artefact. Falls back to the cheapest available option otherwise.
 */
function pickOption(
    hotels: Awaited<ReturnType<typeof certificationSearchService.search>>['hotels'],
): { hotelCode: string; hotelName?: string; option: CertificationOption } | null {
    for (const preferInstant of [true, false]) {
        for (const hotel of hotels) {
            const option = hotel.options.find((o) => (preferInstant ? !o.onRequest : true));
            if (option) {
                return { hotelCode: hotel.hotelCode, hotelName: hotel.hotelName, option };
            }
        }
    }
    return null;
}

// ── Scenario execution ───────────────────────────────────────────────────────

async function runScenario(
    scenario: CertificationScenario,
    opts: RunOptions,
): Promise<ScenarioResult> {
    const started = Date.now();
    const base: ScenarioResult = {
        scenarioId: scenario.id,
        description: scenario.description,
        status: 'failed',
        durationMs: 0,
    };
    const done = (r: Partial<ScenarioResult>): ScenarioResult => ({
        ...base,
        ...r,
        durationMs: Date.now() - started,
    });

    log.step(`Scenario ${scenario.id}: ${scenario.description}`);

    // Nonrefundable scenarios cost real money and stay skipped by default.
    if (!scenario.refundable && !opts.allowNonRefundable) {
        log.warn('Nonrefundable — skipped (pass --allow-nonrefundable with client approval)');
        return done({ status: 'skipped', error: 'Nonrefundable scenario not authorised' });
    }

    const checkIn = checkInDate();
    const found = await searchWithFallback(scenario, checkIn);
    if (!found) {
        log.fail('No options at any candidate destination');
        return done({ error: 'No availability at any candidate destination', optionsFound: 0 });
    }

    const { result, destination } = found;
    const picked = pickOption(result.hotels);
    if (!picked) {
        log.fail('Search returned hotels but no usable option');
        return done({ destination: destination.name, error: 'No usable option', optionsFound: 0 });
    }

    let { hotelCode, hotelName, option } = picked;
    log.info(`Hotel: ${hotelName ?? hotelCode}`);
    log.info(`Option: ${option.totalPrice} ${option.currency}${option.onRequest ? ' (on request)' : ''}`);

    // WBE flags options whose prices came from cache; re-read before relying
    // on them, or the price will move at prebook.
    if (option.updatedOptionsNeeded) {
        log.info('UpdatedOptionsNeeded=true — refreshing via GetUpdatedOptions');
        try {
            const refreshed = await certificationSearchService.getUpdatedOptions(
                result.sessionId,
                hotelCode,
                scenario.mealType,
            );
            const better = refreshed.find((h) => h.hotelCode === hotelCode)?.options?.[0];
            if (better) {
                option = better;
                log.ok(`Refreshed option: ${option.totalPrice} ${option.currency}`);
            }
        } catch (err: any) {
            log.warn(`GetUpdatedOptions failed, continuing with original option — ${err.message}`);
        }
    }

    const partial: Partial<ScenarioResult> = {
        destination: destination.name,
        hotelName,
        hotelCode,
        quotedPrice: option.totalPrice,
        currency: option.currency,
        optionsFound: result.totalOptions,
    };

    // Persist the draft before any state-changing WBE call, so the agency
    // reference exists even if a later call is lost.
    let booking;
    try {
        booking = await wbeBookingService.selectOption({
            sessionId: result.sessionId,
            tid: option.tid,
            hotelCode,
            hotelName,
            destinationId: destination.id,
            destinationName: destination.name,
            checkInDate: new Date(checkIn),
            checkOutDate: new Date(addNights(checkIn, scenario.nights)),
            nights: scenario.nights,
            quotedPrice: option.totalPrice,
            currency: option.currency,
            carbonCopyMail: cfg.CARBON_COPY_MAIL,
            issueVoucherOnBook: false,
            isCertificationTest: true,
            certificationScenario: scenario.id,
            rooms: buildRooms(scenario),
        });
        log.ok(`Draft created — agency ref ${booking.agencyReference}`);
    } catch (err: any) {
        log.fail(`Could not create draft: ${err.message}`);
        return done({ ...partial, error: `selectOption failed: ${err.message}` });
    }

    partial.agencyReference = booking.agencyReference;

    // Mandatory OptionDetailsV2 with Prebook=true.
    try {
        booking = await wbeBookingService.prebook(booking.id);
        const prebookPrice = booking.prebookPrice ? Number(booking.prebookPrice) : undefined;
        const priceChanged = booking.status === 'price_changed';

        partial.prebookPrice = prebookPrice;
        partial.priceChanged = priceChanged;
        partial.nonRefundable = booking.nonRefundable;

        log.ok(
            `Prebooked — ${prebookPrice ?? '?'} ${booking.currency ?? ''}` +
            (priceChanged ? ` (price changed from ${option.totalPrice})` : ''),
        );

        // WBE requires explicit acceptance of a price move. For an unattended
        // run the accepting party is the operator who launched it.
        if (priceChanged) {
            booking = await wbeBookingService.acceptPriceChange(booking.id);
            log.info('Price change accepted (automated run)');
        }
    } catch (err: any) {
        const code = err instanceof BookingFlowError ? ` [${err.code}]` : '';
        log.fail(`Prebook failed${code}: ${err.message}`);
        return done({ ...partial, error: `prebook failed: ${err.message}` });
    }

    if (!opts.book) {
        log.warn('Dry run — BookV2 not called (pass --book to create a real reservation)');
        return done({ ...partial, status: 'prebooked' });
    }

    // BookV2 — the point at which a real reservation exists.
    try {
        booking = await wbeBookingService.book(booking.id);
        log.ok(`BOOKED — reference ${booking.bookingReference} (${booking.wbeStatus})`);
        partial.bookingReference = booking.bookingReference;
        partial.wbeStatus = booking.wbeStatus;
        partial.nonRefundable = booking.nonRefundable;
    } catch (err: any) {
        const code = err instanceof BookingFlowError ? err.code : undefined;

        // An ambiguous dispatch may have created a reservation upstream.
        // Reconcile by agency reference rather than retrying.
        if (code === 'AMBIGUOUS_BOOKING') {
            log.warn('Ambiguous booking — reconciling by agency reference');
            try {
                booking = await wbeBookingService.reconcile(booking.id);
                if (booking.bookingReference) {
                    log.ok(`Recovered — reference ${booking.bookingReference}`);
                    partial.bookingReference = booking.bookingReference;
                    partial.wbeStatus = booking.wbeStatus;
                } else {
                    log.fail('Reconciliation found no booking at WBE');
                    return done({ ...partial, error: 'Ambiguous dispatch; no upstream booking found' });
                }
            } catch (recErr: any) {
                log.fail(`Reconciliation failed: ${recErr.message}`);
                return done({ ...partial, error: `Reconciliation failed: ${recErr.message}` });
            }
        } else {
            log.fail(`Booking failed${code ? ` [${code}]` : ''}: ${err.message}`);
            return done({ ...partial, error: `book failed: ${err.message}` });
        }
    }

    // Cancel refundable test bookings: a confirmed booking left open is
    // charged at its deadline. The reference is already captured above and
    // remains valid for the certification document after cancellation.
    if (opts.cancelAfter && booking.nonRefundable === false) {
        try {
            const cancelled = await wbeBookingService.cancel(booking.id);
            partial.cancelledAfterwards = cancelled.status === 'cancelled';
            log.ok(
                cancelled.status === 'cancelled'
                    ? `Cancelled (charge: ${cancelled.cancellationCharge ?? 0})`
                    : `Cancellation pending manual confirmation at WBE`,
            );
        } catch (err: any) {
            log.warn(`Cancellation failed — booking left open, cancel manually: ${err.message}`);
            partial.cancelledAfterwards = false;
        }
    } else if (booking.nonRefundable) {
        log.warn('Nonrefundable — left in place (cancelling would incur a charge)');
        partial.cancelledAfterwards = false;
    }

    return done({ ...partial, status: 'booked' });
}

// ── Reporting ────────────────────────────────────────────────────────────────

async function writeOutputs(results: ScenarioResult[], opts: RunOptions) {
    const dir = path.resolve(process.cwd(), cfg.OUTPUT_DIR);
    await fs.mkdir(dir, { recursive: true });

    for (const r of results) {
        await fs.writeFile(
            path.join(dir, `scenario-${r.scenarioId}.json`),
            JSON.stringify(r, null, 2),
        );
    }

    const generatedAt = new Date().toISOString();
    await fs.writeFile(
        path.join(dir, 'summary.json'),
        JSON.stringify({ generatedAt, mode: opts.book ? 'live' : 'dry-run', results }, null, 2),
    );

    // Markdown table mirroring WBE's document, ready to transcribe.
    const rows = results
        .map((r) => {
            const ref = r.bookingReference ?? (r.status === 'prebooked' ? '_(dry run)_' : '—');
            return `| ${r.scenarioId} | ${r.description} | ${r.status} | ${ref} |`;
        })
        .join('\n');

    await fs.writeFile(
        path.join(dir, 'summary.md'),
        `# WBE Certification — Booking References\n\n` +
        `Generated: ${generatedAt}\n` +
        `Mode: **${opts.book ? 'LIVE (real bookings)' : 'DRY RUN (no bookings created)'}**\n\n` +
        `| # | Scenario | Status | Booking Reference |\n|---|---|---|---|\n${rows}\n`,
    );

    return dir;
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    console.log('\n\x1b[1mWBE SmartKonnect XMLOUT — Certification Runner\x1b[0m');
    console.log(`Mode:            ${opts.book ? '\x1b[31mLIVE — real bookings will be created\x1b[0m' : '\x1b[32mDRY RUN — no bookings\x1b[0m'}`);
    console.log(`Nonrefundable:   ${opts.allowNonRefundable ? '\x1b[31mENABLED (13, 14 will be booked)\x1b[0m' : 'skipped'}`);
    console.log(`Auto-cancel:     ${opts.cancelAfter ? 'yes (refundable only)' : 'no'}`);
    console.log(`Check-in:        ${checkInDate()} (+${cfg.CHECKIN_DAYS_AHEAD} days)`);
    console.log(`Destinations:    ${cfg.DESTINATION_CANDIDATES.map((d) => d.name).join(' → ')}`);

    const scenarios = opts.scenarioIds
        ? CERTIFICATION_SCENARIOS.filter((s) => opts.scenarioIds!.includes(s.id))
        : CERTIFICATION_SCENARIOS;
    console.log(`Scenarios:       ${scenarios.map((s) => s.id).join(', ')}`);

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
        try {
            results.push(await runScenario(scenario, opts));
        } catch (err: any) {
            // A scenario must never abort the run — the goal is to complete as
            // many as possible, per WBE's own instructions.
            log.fail(`Unhandled error: ${err.message}`);
            results.push({
                scenarioId: scenario.id,
                description: scenario.description,
                status: 'failed',
                error: err.message,
                durationMs: 0,
            });
        }
    }

    const dir = await writeOutputs(results, opts);

    const booked = results.filter((r) => r.status === 'booked');
    const prebooked = results.filter((r) => r.status === 'prebooked');
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'failed');

    console.log('\n\x1b[1m── Summary ──────────────────────────────────────────\x1b[0m');
    console.log(`  Booked (with reference): ${booked.length}`);
    console.log(`  Prebooked (dry run):     ${prebooked.length}`);
    console.log(`  Skipped:                 ${skipped.length}`);
    console.log(`  Failed:                  ${failed.length}`);
    console.log(`\n  Output: ${dir}`);

    if (booked.length > 0) {
        console.log('\n  Booking references for the certification document:');
        booked.forEach((r) => console.log(`    Scenario ${String(r.scenarioId).padStart(2)}: ${r.bookingReference}`));
    }
    if (failed.length > 0) {
        console.log('\n  Failures:');
        failed.forEach((r) => console.log(`    Scenario ${String(r.scenarioId).padStart(2)}: ${r.error}`));
    }

    // Leaving a confirmed booking open costs money at its deadline.
    const openBookings = booked.filter((r) => r.cancelledAfterwards === false && !r.nonRefundable);
    if (openBookings.length > 0) {
        console.log('\n  \x1b[33mWARNING — these refundable bookings are still open and will be charged at deadline:\x1b[0m');
        openBookings.forEach((r) => console.log(`    Scenario ${r.scenarioId}: ${r.bookingReference}`));
    }

    await prisma.$disconnect();
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
    console.error('\nRunner crashed:', err);
    await prisma.$disconnect();
    process.exit(1);
});
