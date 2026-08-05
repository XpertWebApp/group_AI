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
    /**
     * WBE accepted the cancellation but the supplier has not settled it yet
     * (status PNDC). Distinct from cancelledAfterwards=false, which means the
     * booking is genuinely still live and someone has to act on it.
     */
    cancellationPending?: boolean;
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
 * Yield each candidate destination that returns options, in order.
 *
 * UAT suppliers answer inconsistently, so a destination returning nothing is
 * expected rather than a failure — WBE says as much in the certification notes.
 * Only exhausting every candidate counts as a real miss.
 *
 * A generator rather than a single result: a destination can return plenty of
 * options and still have none that are refundable, and the caller cannot know
 * that until it has prebooked them. Yielding lets it move to the next city
 * instead of giving up on the first one that answered.
 */
async function* searchWithFallback(scenario: CertificationScenario, checkIn: string) {
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
                yield { result, destination: dest };
            } else {
                log.info(`${dest.name}: no options, trying next destination`);
            }
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
    return rankOptions(hotels)[0] ?? null;
}

/**
 * Every option worth attempting, best first.
 *
 * Refundability is not in the search response — it only comes back from
 * prebook — so a caller that needs a refundable option cannot filter here and
 * has to walk this list, prebooking until one qualifies. Instantly
 * confirmable options come first for the reason above; within each group the
 * search order (cheapest first) is preserved.
 *
 * One entry per hotel per pass, so successive attempts move to a different
 * property rather than trying every rate at the same one.
 */
function rankOptions(
    hotels: Awaited<ReturnType<typeof certificationSearchService.search>>['hotels'],
): Array<{ hotelCode: string; hotelName?: string; option: CertificationOption }> {
    const ranked: Array<{ hotelCode: string; hotelName?: string; option: CertificationOption }> = [];
    const seen = new Set<string>();

    for (const preferInstant of [true, false]) {
        for (const hotel of hotels) {
            const option = hotel.options.find((o) => (preferInstant ? !o.onRequest : true));
            if (option && !seen.has(option.tid)) {
                seen.add(option.tid);
                ranked.push({ hotelCode: hotel.hotelCode, hotelName: hotel.hotelName, option });
            }
        }
    }
    return ranked;
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
    let searched = false;
    let lastError: string | undefined;
    let lastDestination: string | undefined;
    let lastOptionCount = 0;

    // Refundability is only known after prebook, so when a candidate comes back
    // nonrefundable for a refundable scenario we prebook the next one instead
    // of giving up. Prebook holds inventory briefly but creates no reservation,
    // so an abandoned attempt costs nothing. Bounded per destination so a city
    // whose entire inventory is nonrefundable cannot work through all of it,
    // and the search then moves on to the next city rather than stopping.
    for await (const { result, destination } of searchWithFallback(scenario, checkIn)) {
        searched = true;
        lastDestination = destination.name;
        lastOptionCount = result.totalOptions;

        const candidates = rankOptions(result.hotels);
        if (candidates.length === 0) {
            log.info(`${destination.name}: no usable option, trying next destination`);
            continue;
        }

        const maxAttempts = Math.min(candidates.length, cfg.MAX_OPTION_ATTEMPTS);
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const outcome = await attemptOption(
                scenario,
                opts,
                candidates[attempt]!,
                { result, destination, checkIn },
                attempt,
                maxAttempts,
            );
            if (outcome.done) return outcome.done;
            lastError = outcome.retryReason;
        }

        log.warn(
            `${destination.name}: no refundable option in ${maxAttempts} attempt(s) — trying next destination`,
        );
    }

    if (!searched) {
        log.fail('No options at any candidate destination');
        return done({ error: 'No availability at any candidate destination', optionsFound: 0 });
    }

    log.fail('No refundable option at any candidate destination');
    return done({
        destination: lastDestination,
        optionsFound: lastOptionCount,
        status: 'skipped',
        error: lastError ?? 'No refundable option available',
    });
}

/**
 * Take one candidate option as far as it will go.
 *
 * Returns `done` with a final result, or `retryReason` when the caller should
 * move on to the next candidate. Only a nonrefundable prebook is retryable —
 * every other failure is reported as-is, since retrying would repeat it.
 */
async function attemptOption(
    scenario: CertificationScenario,
    opts: RunOptions,
    picked: { hotelCode: string; hotelName?: string; option: CertificationOption },
    ctx: {
        result: Awaited<ReturnType<typeof certificationSearchService.search>>;
        destination: (typeof cfg.DESTINATION_CANDIDATES)[number];
        checkIn: string;
    },
    attempt: number,
    maxAttempts: number,
): Promise<{ done?: ScenarioResult; retryReason?: string }> {
    const { result, destination, checkIn } = ctx;
    const done = (partial: Partial<ScenarioResult>): ScenarioResult => ({
        scenarioId: scenario.id,
        description: scenario.description,
        status: 'failed',
        ...partial,
    } as ScenarioResult);

    let { hotelCode, hotelName, option } = picked;
    if (attempt > 0) log.info(`Attempt ${attempt + 1}/${maxAttempts} — trying another option`);
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
        return { done: done({ ...partial, error: `selectOption failed: ${err.message}` }) };
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
        // A prebook rejection is about this option, not the scenario: WBE
        // refuses individual rates for reasons we cannot see from the search
        // response (CancellationPolicy Error is the common one). Nothing has
        // been reserved, so the sensible response is the next candidate rather
        // than failing a scenario that other options could still satisfy.
        log.warn(`Prebook rejected${code}: ${err.message} — trying another option`);
        return { retryReason: `prebook failed: ${err.message}` };
    }

    if (!opts.book) {
        log.warn('Dry run — BookV2 not called (pass --book to create a real reservation)');
        return { done: done({ ...partial, status: 'prebooked' }) };
    }

    // A scenario marked refundable says what WBE's document asks for, not what
    // the option we happened to pick actually is: refundability is absent from
    // the search response and only known once prebook returns. Booking a
    // nonrefundable option here would voucher it immediately, so it could not
    // be cancelled afterwards and would be charged in full. Stop instead — no
    // reservation exists yet at this point.
    if (scenario.refundable && booking.nonRefundable === true) {
        log.warn('Prebook came back nonrefundable for a refundable scenario — trying another option');
        return { retryReason: 'Every option attempted came back nonrefundable' };
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
                    return { done: done({ ...partial, error: 'Ambiguous dispatch; no upstream booking found' }) };
                }
            } catch (recErr: any) {
                log.fail(`Reconciliation failed: ${recErr.message}`);
                return { done: done({ ...partial, error: `Reconciliation failed: ${recErr.message}` }) };
            }
        } else {
            log.fail(`Booking failed${code ? ` [${code}]` : ''}: ${err.message}`);
            return { done: done({ ...partial, error: `book failed: ${err.message}` }) };
        }
    }

    // Cancel refundable test bookings: a confirmed booking left open is
    // charged at its deadline. The reference is already captured above and
    // remains valid for the certification document after cancellation.
    if (opts.cancelAfter && booking.nonRefundable === false) {
        try {
            const cancelled = await wbeBookingService.cancel(booking.id);
            partial.cancelledAfterwards = cancelled.status === 'cancelled';
            // PNDC: WBE took the request and is waiting on the supplier. The
            // booking is on its way out, so it does not belong in the
            // still-open warning at the end of the run.
            partial.cancellationPending = cancelled.status === 'pending_cancellation';
            log.ok(
                cancelled.status === 'cancelled'
                    ? `Cancelled (charge: ${cancelled.cancellationCharge ?? 0})`
                    : `Cancellation accepted by WBE, awaiting supplier settlement (PNDC)`,
            );
        } catch (err: any) {
            log.warn(`Cancellation failed — booking left open, cancel manually: ${err.message}`);
            partial.cancelledAfterwards = false;
        }
    } else if (booking.nonRefundable) {
        log.warn('Nonrefundable — left in place (cancelling would incur a charge)');
        partial.cancelledAfterwards = false;
    } else if (opts.cancelAfter) {
        // nonRefundable is nullable and WBE does not always return the field.
        // Neither branch above matches when it is null, so without this the
        // booking stays open silently and is charged at its deadline.
        log.warn(
            'Refundability unknown (WBE returned no NonRefundable flag) — ' +
                'not cancelled automatically. Check this booking and cancel it manually.',
        );
        partial.cancelledAfterwards = false;
    }

    return { done: done({ ...partial, status: 'booked' }) };
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

    // Summarise every scenario file on disk, not just the ones this run
    // touched. Scenarios are executed one or a few at a time, so a summary
    // built from `results` alone would list the latest run and drop every
    // reference captured before it — and those references are the deliverable.
    const summarised: ScenarioResult[] = [];
    for (const scenario of CERTIFICATION_SCENARIOS) {
        const fresh = results.find((r) => r.scenarioId === scenario.id);
        if (fresh) {
            summarised.push(fresh);
            continue;
        }
        try {
            const raw = await fs.readFile(path.join(dir, `scenario-${scenario.id}.json`), 'utf8');
            summarised.push(JSON.parse(raw) as ScenarioResult);
        } catch {
            // Never run, or the file was removed — omitted from the table.
        }
    }

    const generatedAt = new Date().toISOString();
    await fs.writeFile(
        path.join(dir, 'summary.json'),
        JSON.stringify(
            { generatedAt, mode: opts.book ? 'live' : 'dry-run', results: summarised },
            null,
            2,
        ),
    );

    // Markdown table mirroring WBE's document, ready to transcribe.
    const rows = summarised
        .map((r) => {
            const ref = r.bookingReference ?? (r.status === 'prebooked' ? '_(dry run)_' : '—');
            return `| ${r.scenarioId} | ${r.description} | ${r.status} | ${ref} |`;
        })
        .join('\n');

    await fs.writeFile(
        path.join(dir, 'summary.md'),
        `# WBE Certification — Booking References\n\n` +
        `Generated: ${generatedAt}\n` +
        // The table spans every scenario run so far, so it describes the file
        // as a whole rather than the run that last wrote it — labelling it
        // from `opts.book` would mark a table full of live references as a
        // dry run whenever the most recent run happened to be one.
        `Last run: **${opts.book ? 'LIVE (real bookings)' : 'DRY RUN (no bookings created)'}**\n` +
        `Booked so far: **${summarised.filter((r) => r.bookingReference).length} of ${CERTIFICATION_SCENARIOS.length}**\n\n` +
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

    // Leaving a confirmed booking open costs money at its deadline. The filter
    // keeps rows whose nonRefundable is null as well as false — an unknown
    // flag is exactly the case that needs a human to look.
    const openBookings = booked.filter(
        (r) => r.cancelledAfterwards === false && !r.cancellationPending && !r.nonRefundable,
    );
    if (openBookings.length > 0) {
        console.log('\n  \x1b[33mWARNING — these bookings are still open and will be charged at deadline:\x1b[0m');
        openBookings.forEach((r) =>
            console.log(
                `    Scenario ${r.scenarioId}: ${r.bookingReference}` +
                    (r.nonRefundable == null ? '  (refundability unknown)' : ''),
            ),
        );
    }

    // Accepted by WBE but not settled by the supplier. No action needed, but
    // worth stating so the run does not look like it left something behind.
    const pending = booked.filter((r) => r.cancellationPending);
    if (pending.length > 0) {
        console.log('\n  Cancellation accepted, awaiting supplier settlement (no action needed):');
        pending.forEach((r) => console.log(`    Scenario ${r.scenarioId}: ${r.bookingReference}`));
    }

    await prisma.$disconnect();
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
    console.error('\nRunner crashed:', err);
    await prisma.$disconnect();
    process.exit(1);
});
