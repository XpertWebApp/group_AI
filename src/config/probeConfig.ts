/**
 * Hotel capacity probing configuration.
 * Each hotel is probed in batches of PROBE_BATCH_SIZE rooms (R1-R3, R4-R6, ...)
 * up to PROBE_MULTIPLIER × requestedRooms before evaluating capacity.
 */

export const PROBE_BATCH_SIZE = Number(process.env.PROBE_BATCH_SIZE ?? 3);
export const PROBE_MULTIPLIER = Number(process.env.PROBE_MULTIPLIER ?? 2);
export const WORKER_JOB_CONCURRENCY = Number(process.env.WORKER_JOB_CONCURRENCY ?? 5);
export const WBE_GLOBAL_RATE_LIMIT = Number(process.env.WBE_GLOBAL_RATE_LIMIT ?? 10); // calls/sec
export const PROBE_WAIT_SECONDS = Number(process.env.PROBE_WAIT_SECONDS ?? 45);
export const PROBE_POLL_INTERVAL_MS = Number(process.env.PROBE_POLL_INTERVAL_MS ?? 3000);
export const PROBE_POLL_TIMEOUT_MS = Number(process.env.PROBE_POLL_TIMEOUT_MS ?? 60000);

/** Room type → number of adults mapping for WBE search rooms. */
export const ROOM_TYPE_ADULTS: Record<string, number> = {
    single: 1,
    double: 2,
    twin: 2,
    triple: 3,
    quadruple: 4,
    suites: 2,
};
