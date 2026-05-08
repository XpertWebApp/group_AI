"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotelSearchController = void 0;
const hotelSearch_service_1 = __importDefault(require("../services/hotelSearch.service"));
const hotelProbeJob_repository_1 = __importDefault(require("../repositories/hotelProbeJob.repository"));
const sseManager_1 = require("../services/sseManager");
const response_1 = require("../utils/response");
class HotelSearchController {
    /**
     * POST /api/v1/requests/:id/hotel-search
     *
     * Triggers the full hotel search orchestration for a booking request.
     * Steps 1-6 from the SETT Phase 1 guide.
     */
    async search(req, res, next) {
        try {
            const requestId = req.params['id'];
            const body = req.validated?.body ?? req.body;
            const result = await hotelSearch_service_1.default.searchForRequest(requestId, {
                mealType: body.mealType,
                includeAlternativeStars: body.includeAlternativeStars,
                waitSeconds: body.waitSeconds,
                currencyCode: body.currencyCode,
                nationalityCode: body.nationalityCode,
                facilityIds: body.facilityIds,
                lang: body.lang,
            });
            return (0, response_1.sendResponse)(res, 200, result, 'Hotel search completed');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * POST /api/v1/requests/:id/hotel-search/alternatives
     *
     * User-triggered relaxed-criteria search ("Show alternatives" button).
     * Returns hotels matching widened criteria, excluding hotelCodes already
     * shown by the main search. The body may carry the relaxation level used
     * by the main search so we know where to start on the ladder.
     */
    async searchAlternatives(req, res, next) {
        try {
            const requestId = req.params['id'];
            const body = req.validated?.body ?? req.body ?? {};
            const result = await hotelSearch_service_1.default.searchAlternativesForRequest(requestId, {
                mealType: body.mealType,
                waitSeconds: body.waitSeconds,
                currencyCode: body.currencyCode,
                nationalityCode: body.nationalityCode,
                facilityIds: body.facilityIds,
                lang: body.lang,
            }, body.appliedLevel);
            return (0, response_1.sendResponse)(res, 200, result, 'Alternative hotel search triggered');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * POST /api/v1/requests/:id/hotel-search/option-details
     *
     * Fetches and caches OptionDetailsV2 for selected TIDs.
     * Step 6 from the SETT Phase 1 guide (exact per-night pricing + cancellation policy).
     */
    async optionDetails(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const result = await hotelSearch_service_1.default.fetchOptionDetails(body.selections);
            return (0, response_1.sendResponse)(res, 200, result, 'Option details retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * GET /api/v1/requests/:id/hotel-search/events
     *
     * SSE stream — emits hotelProbeProgress and hotelProbeCompleted events
     * as each HotelProbeJob finishes processing in the worker.
     */
    async events(req, res) {
        const requestId = req.params['id'];
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
        res.flushHeaders();
        // Register this response for broadcasts from the worker
        (0, sseManager_1.subscribe)(requestId, res);
        // Send an initial heartbeat so the client knows the stream is open
        res.write(`event: connected\ndata: ${JSON.stringify({ requestId, message: 'Subscribed to hotel probe events' })}\n\n`);
        // Keep-alive ping every 20 s
        const pingInterval = setInterval(() => {
            res.write(': ping\n\n');
        }, 20000);
        req.on('close', () => clearInterval(pingInterval));
    }
    /**
     * GET /api/v1/requests/:id/hotel-search/status
     *
     * Polling endpoint — returns current state of all HotelProbeJobs for
     * this search request (for clients that cannot use SSE).
     */
    async probeStatus(req, res, next) {
        try {
            const requestId = req.params['id'];
            const jobs = await hotelProbeJob_repository_1.default.findBySearchRequest(requestId);
            const summary = {
                total: jobs.length,
                queued: jobs.filter((j) => j.status === 'QUEUED').length,
                running: jobs.filter((j) => j.status === 'RUNNING' || j.status === 'PROBING').length,
                completed: jobs.filter((j) => j.status === 'COMPLETED').length,
                skipped: jobs.filter((j) => j.status === 'SKIPPED_INSUFFICIENT').length,
                failed: jobs.filter((j) => j.status === 'FAILED').length,
            };
            return (0, response_1.sendResponse)(res, 200, { requestId, summary, jobs }, 'Probe status');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * POST /api/v1/requests/:id/hotel-search/calculate-price
     *
     * Calculates the recommended customer sell price for a given buying price + markup.
     * Step 7 from the SETT Phase 1 guide.
     */
    async calculatePrice(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const { buyingPrice, markupPercent } = body;
            const result = hotelSearch_service_1.default.calculateSellPrice(buyingPrice, markupPercent);
            return (0, response_1.sendResponse)(res, 200, result, 'Price calculated');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.HotelSearchController = HotelSearchController;
exports.default = new HotelSearchController();
