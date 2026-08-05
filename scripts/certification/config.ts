/**
 * Configuration for the WBE certification runner.
 *
 * Everything an operator needs to change lives here, so running certification
 * against a different destination or date never means editing runner logic.
 *
 * Nothing in this file books anything by itself — see BOOKING_ENABLED below.
 */

/**
 * Destinations to search, tried in order until one returns options.
 *
 * WBE's own certification notes say some scenarios may return nothing "due to
 * the dynamic availability of the configured test suppliers", and a previous
 * search-only run against Rome came back with zero options for every scenario.
 * A single hardcoded destination therefore cannot be relied on: the runner
 * falls through this list per scenario rather than reporting a false failure.
 *
 * IDs are from master.destinations, chosen for large local inventory.
 */
export const DESTINATION_CANDIDATES: Array<{ id: number; name: string }> = [
    { id: 1842893, name: 'Rome' },
    { id: 39707, name: 'Paris' },
    { id: 30279, name: 'London' },
    { id: 23813, name: 'Istanbul' },
    { id: 4347, name: 'Bangkok' },
];

/** Hotel codes per WBE search call. WBE's documented maximum is 100. */
export const HOTEL_BATCH_SIZE = 100;

/**
 * How far ahead to check in.
 *
 * Far enough out that inventory is open and cancellation deadlines have not
 * passed, so refundable test bookings can still be cancelled free of charge.
 */
export const CHECKIN_DAYS_AHEAD = 45;

export const CURRENCY_CODE = 'EUR';
export const NATIONALITY_CODE = 'DE';

/** Seconds WBE holds the search open before returning a first batch. */
export const SEARCH_WAIT_SECONDS = 15;

/**
 * How many options a refundable scenario may prebook before giving up.
 *
 * Refundability only comes back from prebook, so finding a refundable option
 * means trying them one at a time. Each attempt is a WBE round trip that holds
 * inventory briefly but creates no reservation. The cap stops a destination
 * whose entire inventory is nonrefundable from working through every option.
 */
export const MAX_OPTION_ATTEMPTS = 5;

/**
 * Master switch for creating real reservations.
 *
 * Default false: the runner searches and prebooks but never calls BookV2, so
 * an accidental run cannot consume credit or create reservations. Booking is
 * enabled only by passing --book on the command line, which additionally
 * requires the client confirmations described in README.md.
 */
export const BOOKING_ENABLED = false;

/**
 * Master switch for scenarios 13 and 14, which WBE marks Nonrefundable.
 *
 * A nonrefundable booking is vouchered immediately and cannot be cancelled
 * without charge — these two scenarios cost real money. Enabled only by
 * passing --allow-nonrefundable, and only meaningful alongside --book.
 * Do not enable without written client approval.
 */
export const ALLOW_NONREFUNDABLE = false;

/**
 * Whether to cancel refundable test bookings once a reference is captured.
 *
 * On by default: an uncancelled confirmed booking is charged at its deadline,
 * so leaving 12 test reservations open would cost money. The booking reference
 * needed for the certification document is recorded before cancelling, and
 * cancelling does not invalidate it.
 */
export const AUTO_CANCEL_AFTER_BOOKING = true;

/** Passenger names used for test bookings. */
export const PASSENGER_LAST_NAME = 'Tester';
export const ADULT_FIRST_NAMES = [
    'John', 'Jane', 'Peter', 'Mary', 'Paul', 'Anna', 'Mark', 'Julia', 'Simon',
];
export const CHILD_FIRST_NAMES = [
    'Tom', 'Lucy', 'Max', 'Emma', 'Leo', 'Mia', 'Noah', 'Zoe',
];

/** Contact address for booking notifications, if configured. */
export const CARBON_COPY_MAIL = process.env['WBE_BOOKING_NOTIFICATION_EMAIL'] || undefined;

/** Where per-scenario payloads and the summary are written. */
export const OUTPUT_DIR = 'scripts/output/certification';
