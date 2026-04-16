"use strict";
/**
 * Hotel capacity probing configuration.
 * Each hotel is probed in batches of PROBE_BATCH_SIZE rooms (R1-R3, R4-R6, ...)
 * up to PROBE_MULTIPLIER × requestedRooms before evaluating capacity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROOM_TYPE_ADULTS = exports.OVERLAP_DISCOUNT_FACTOR = exports.MULTI_SUPPLIER_OVERLAP_THRESHOLD = exports.PROBE_POLL_TIMEOUT_MS = exports.PROBE_POLL_INTERVAL_MS = exports.PROBE_WAIT_SECONDS = exports.WBE_GLOBAL_RATE_LIMIT = exports.WORKER_JOB_CONCURRENCY = exports.PROBE_MULTIPLIER = exports.PROBE_BATCH_SIZE = void 0;
exports.PROBE_BATCH_SIZE = Number(process.env.PROBE_BATCH_SIZE ?? 3);
exports.PROBE_MULTIPLIER = Number(process.env.PROBE_MULTIPLIER ?? 2);
exports.WORKER_JOB_CONCURRENCY = Number(process.env.WORKER_JOB_CONCURRENCY ?? 2);
exports.WBE_GLOBAL_RATE_LIMIT = Number(process.env.WBE_GLOBAL_RATE_LIMIT ?? 10); // calls/sec
exports.PROBE_WAIT_SECONDS = Number(process.env.PROBE_WAIT_SECONDS ?? 45);
exports.PROBE_POLL_INTERVAL_MS = Number(process.env.PROBE_POLL_INTERVAL_MS ?? 3000);
exports.PROBE_POLL_TIMEOUT_MS = Number(process.env.PROBE_POLL_TIMEOUT_MS ?? 60000);
/** Below this room count, trust supplier claims without overlap discount (multi-supplier only). */
exports.MULTI_SUPPLIER_OVERLAP_THRESHOLD = Number(process.env.MULTI_SUPPLIER_OVERLAP_THRESHOLD ?? 15);
/** For large multi-supplier requests, assume this fraction of supplier claims is unique inventory. */
exports.OVERLAP_DISCOUNT_FACTOR = Number(process.env.OVERLAP_DISCOUNT_FACTOR ?? 0.75);
/** Room type → number of adults mapping for WBE search rooms. */
exports.ROOM_TYPE_ADULTS = {
    single: 1,
    double: 2,
    twin: 2,
    triple: 3,
    quadruple: 4,
    suites: 2,
    standardDoubleBeds: 2,
    twinBeds: 2,
};
