"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const requests_controller_1 = __importDefault(require("../controllers/requests.controller"));
const hotelSearch_controller_1 = __importDefault(require("../controllers/hotelSearch.controller"));
const attachments_controller_1 = __importStar(require("../controllers/attachments.controller"));
const auth_middleware_1 = require("../middlewares/auth.middleware");
const validate_middleware_1 = require("../middlewares/validate.middleware");
const requestSchemas_1 = require("../validation/requestSchemas");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const router = (0, express_1.Router)();
const createLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 50,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});
// Rate limiter for WBE search calls (expensive external API)
const searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000, // 1 min
    max: 10,
    message: { error: { code: 'rate_limited', message: 'Too many search requests, try again later' } },
});
// ── Booking Request CRUD ───────────────────────────────────────────────────
router.post('/', auth_middleware_1.authMiddleware, createLimiter, (0, validate_middleware_1.validate)(requestSchemas_1.CreateBookingRequestSchema, 'body'), requests_controller_1.default.create);
router.get('/', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.ListRequestsQuerySchema, 'query'), requests_controller_1.default.list);
router.get('/:id', auth_middleware_1.authMiddleware, requests_controller_1.default.get);
router.get('/:id/summary', auth_middleware_1.authMiddleware, requests_controller_1.default.getSummary);
router.patch('/:id', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.UpdateBookingRequestSchema, 'body'), requests_controller_1.default.update);
// Explicit self-claim from the dashboard. No auto-claim middleware — the
// controller handles the claim + conflict response itself.
router.post('/:id/actions/claim', auth_middleware_1.authMiddleware, requests_controller_1.default.claim);
// ── Hotel Search Flow (Create Request → Search → Option Details) ───────────
/**
 * POST /requests/:id/hotel-search
 * Triggers the WBE hotel search for a booking request.
 * Returns filtered, capacity-validated, and ranked hotel options with supplier splits.
 * Steps 1-5 from the SETT Phase 1 guide.
 */
router.post('/:id/hotel-search', auth_middleware_1.authMiddleware, searchLimiter, (0, validate_middleware_1.validate)(requestSchemas_1.WbeHotelSearchSchema, 'body'), hotelSearch_controller_1.default.search);
/**
 * POST /requests/:id/hotel-search/alternatives
 * User-triggered relaxed-criteria search ("Show alternatives" button).
 * Returns hotels at wider star/meal/location/facility criteria, excluding
 * those already in the main results.
 */
router.post('/:id/hotel-search/alternatives', auth_middleware_1.authMiddleware, searchLimiter, hotelSearch_controller_1.default.searchAlternatives);
/**
 * GET /requests/:id/hotel-search/events
 * SSE stream — real-time hotel probe progress + completed events.
 */
router.get('/:id/hotel-search/events', auth_middleware_1.authMiddleware, hotelSearch_controller_1.default.events);
/**
 * GET /requests/:id/hotel-search/status
 * Polling endpoint — returns current HotelProbeJob states for clients without SSE.
 */
router.get('/:id/hotel-search/status', auth_middleware_1.authMiddleware, hotelSearch_controller_1.default.probeStatus);
/**
 * POST /requests/:id/hotel-search/option-details
 * Fetches exact per-night pricing and cancellation policy (OptionDetailsV2) for selected TIDs.
 * Step 6 from the SETT Phase 1 guide. Results are cached in HotelOptionDetail.
 */
router.post('/:id/hotel-search/option-details', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.OptionDetailsRequestSchema, 'body'), hotelSearch_controller_1.default.optionDetails);
/**
 * POST /requests/:id/hotel-search/calculate-price
 * Calculates the recommended customer sell price (highest mid-range + markup + psychology).
 * Step 7 from the SETT Phase 1 guide.
 */
router.post('/:id/hotel-search/calculate-price', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.PriceCalculationSchema, 'body'), hotelSearch_controller_1.default.calculatePrice);
// ── Guest List / Attachments ──────────────────────────────────────────────
router.post('/:id/attachments', auth_middleware_1.authMiddleware, attachments_controller_1.upload.array('files', 5), attachments_controller_1.default.upload);
router.get('/:id/attachments', auth_middleware_1.authMiddleware, attachments_controller_1.default.list);
router.delete('/:id/attachments/:attachmentId', auth_middleware_1.authMiddleware, attachments_controller_1.default.delete);
// ── Create Proposal on a Request ───────────────────────────────────────────
router.post('/:requestId/proposals', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.CreateProposalSchema, 'body'), requests_controller_1.default.createProposal);
exports.default = router;
