import { Router } from 'express';
import requestsController from '../controllers/requests.controller';
import hotelSearchController from '../controllers/hotelSearch.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    CreateBookingRequestSchema,
    UpdateBookingRequestSchema,
    CreateProposalSchema,
    WbeHotelSearchSchema,
    OptionDetailsRequestSchema,
    PriceCalculationSchema,
    ListRequestsQuerySchema,
} from '../validation/requestSchemas';
import rateLimit from 'express-rate-limit';

const router = Router();

const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 50,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

// Rate limiter for WBE search calls (expensive external API)
const searchLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    max: 10,
    message: { error: { code: 'rate_limited', message: 'Too many search requests, try again later' } },
});

// ── Booking Request CRUD ───────────────────────────────────────────────────

router.post(
    '/',
    authMiddleware,
    createLimiter,
    validate(CreateBookingRequestSchema, 'body'),
    requestsController.create,
);

router.get('/', authMiddleware, validate(ListRequestsQuerySchema, 'query'), requestsController.list);

router.get('/:id', authMiddleware, requestsController.get);

router.get('/:id/summary', authMiddleware, requestsController.getSummary);

router.patch(
    '/:id',
    authMiddleware,
    validate(UpdateBookingRequestSchema, 'body'),
    requestsController.update,
);

// ── Hotel Search Flow (Create Request → Search → Option Details) ───────────

/**
 * POST /requests/:id/hotel-search
 * Triggers the WBE hotel search for a booking request.
 * Returns filtered, capacity-validated, and ranked hotel options with supplier splits.
 * Steps 1-5 from the SETT Phase 1 guide.
 */
router.post(
    '/:id/hotel-search',
    authMiddleware,
    searchLimiter,
    validate(WbeHotelSearchSchema, 'body'),
    hotelSearchController.search,
);

/**
 * GET /requests/:id/hotel-search/events
 * SSE stream — real-time hotel probe progress + completed events.
 */
router.get(
    '/:id/hotel-search/events',
    authMiddleware,
    hotelSearchController.events,
);

/**
 * GET /requests/:id/hotel-search/status
 * Polling endpoint — returns current HotelProbeJob states for clients without SSE.
 */
router.get(
    '/:id/hotel-search/status',
    authMiddleware,
    hotelSearchController.probeStatus,
);

/**
 * POST /requests/:id/hotel-search/option-details
 * Fetches exact per-night pricing and cancellation policy (OptionDetailsV2) for selected TIDs.
 * Step 6 from the SETT Phase 1 guide. Results are cached in HotelOptionDetail.
 */
router.post(
    '/:id/hotel-search/option-details',
    authMiddleware,
    validate(OptionDetailsRequestSchema, 'body'),
    hotelSearchController.optionDetails,
);

/**
 * POST /requests/:id/hotel-search/calculate-price
 * Calculates the recommended customer sell price (highest mid-range + markup + psychology).
 * Step 7 from the SETT Phase 1 guide.
 */
router.post(
    '/:id/hotel-search/calculate-price',
    authMiddleware,
    validate(PriceCalculationSchema, 'body'),
    hotelSearchController.calculatePrice,
);

// ── Create Proposal on a Request ───────────────────────────────────────────

router.post(
    '/:requestId/proposals',
    authMiddleware,
    validate(CreateProposalSchema, 'body'),
    requestsController.createProposal,
);

export default router;
