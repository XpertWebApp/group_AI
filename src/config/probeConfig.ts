/**
 * Hotel capacity probing configuration.
 * Each hotel is probed in batches of PROBE_BATCH_SIZE rooms (R1-R3, R4-R6, ...)
 * up to PROBE_MULTIPLIER × requestedRooms before evaluating capacity.
 */

export const PROBE_BATCH_SIZE = Number(process.env.PROBE_BATCH_SIZE ?? 3);
export const PROBE_MULTIPLIER = Number(process.env.PROBE_MULTIPLIER ?? 2);
export const WORKER_JOB_CONCURRENCY = Number(process.env.WORKER_JOB_CONCURRENCY ?? 2);
export const WBE_GLOBAL_RATE_LIMIT = Number(process.env.WBE_GLOBAL_RATE_LIMIT ?? 10); // calls/sec
export const PROBE_WAIT_SECONDS = Number(process.env.PROBE_WAIT_SECONDS ?? 45);
export const PROBE_POLL_INTERVAL_MS = Number(process.env.PROBE_POLL_INTERVAL_MS ?? 3000);
export const PROBE_POLL_TIMEOUT_MS = Number(process.env.PROBE_POLL_TIMEOUT_MS ?? 60000);

/** Below this room count, trust supplier claims without overlap discount (multi-supplier only). */
export const MULTI_SUPPLIER_OVERLAP_THRESHOLD = Number(process.env.MULTI_SUPPLIER_OVERLAP_THRESHOLD ?? 15);

// ─── Search pagination (Option 1: stop after N viable hotels) ────────────────
// When a destination has more candidates than SEARCH_BATCH_SIZE, the search
// pipeline iterates in batches: probe one batch, count viable hotels, queue
// another batch if still below target. Stops on target_met, destination
// exhausted, or after MAX_SEARCH_BATCHES regardless. See plan file.

/** Hotels fetched per pagination batch from master.hotels for a destination. */
export const SEARCH_BATCH_SIZE = Number(process.env.SEARCH_BATCH_SIZE ?? 200);

/** Stop iterating once this many hotels have returned a viable probe result (status='COMPLETED'). */
export const TARGET_VIABLE_HOTELS = Number(process.env.TARGET_VIABLE_HOTELS ?? 50);

/** Absolute cap on pagination batches per destination level — prevents runaway loops on pathological cases. */
export const MAX_SEARCH_BATCHES = Number(process.env.MAX_SEARCH_BATCHES ?? 5);

/** For large multi-supplier requests, assume this fraction of supplier claims is unique inventory. */
export const OVERLAP_DISCOUNT_FACTOR = Number(process.env.OVERLAP_DISCOUNT_FACTOR ?? 0.75);

/** Room type → number of adults mapping for WBE search rooms. */
export const ROOM_TYPE_ADULTS: Record<string, number> = {
    single: 1,
    double: 2,
    twin: 2,
    triple: 3,
    quadruple: 4,
    suites: 2,
    standardDoubleBeds: 2,
    twinBeds: 2,
};
