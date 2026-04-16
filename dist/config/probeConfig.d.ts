/**
 * Hotel capacity probing configuration.
 * Each hotel is probed in batches of PROBE_BATCH_SIZE rooms (R1-R3, R4-R6, ...)
 * up to PROBE_MULTIPLIER × requestedRooms before evaluating capacity.
 */
export declare const PROBE_BATCH_SIZE: number;
export declare const PROBE_MULTIPLIER: number;
export declare const WORKER_JOB_CONCURRENCY: number;
export declare const WBE_GLOBAL_RATE_LIMIT: number;
export declare const PROBE_WAIT_SECONDS: number;
export declare const PROBE_POLL_INTERVAL_MS: number;
export declare const PROBE_POLL_TIMEOUT_MS: number;
/** Below this room count, trust supplier claims without overlap discount (multi-supplier only). */
export declare const MULTI_SUPPLIER_OVERLAP_THRESHOLD: number;
/** For large multi-supplier requests, assume this fraction of supplier claims is unique inventory. */
export declare const OVERLAP_DISCOUNT_FACTOR: number;
/** Room type → number of adults mapping for WBE search rooms. */
export declare const ROOM_TYPE_ADULTS: Record<string, number>;
