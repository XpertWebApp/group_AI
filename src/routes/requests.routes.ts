import { Router } from 'express';
import requestsController from '../controllers/requests.controller';
import hotelSearchController from '../controllers/hotelSearch.controller';
import attachmentsController, { upload } from '../controllers/attachments.controller';
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

// Explicit self-claim from the dashboard. No auto-claim middleware — the
// controller handles the claim + conflict response itself.
router.post('/:id/actions/claim', authMiddleware, requestsController.claim);

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
 * POST /requests/:id/hotel-search/alternatives
 * User-triggered relaxed-criteria search ("Show alternatives" button).
 * Returns hotels at wider star/meal/location/facility criteria, excluding
 * those already in the main results.
 */
router.post(
    '/:id/hotel-search/alternatives',
    authMiddleware,
    searchLimiter,
    hotelSearchController.searchAlternatives,
);

/**
 * POST /requests/:id/hotel-search/more
 * User-triggered "Search More" — queues the next 200-hotel batch at the
 * same destination/star level the previous search settled at.
 */
router.post(
    '/:id/hotel-search/more',
    authMiddleware,
    searchLimiter,
    hotelSearchController.searchMore,
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

// ── Guest List / Attachments ──────────────────────────────────────────────

router.post(
    '/:id/attachments',
    authMiddleware,
    upload.array('files', 5),
    attachmentsController.upload,
);

router.get('/:id/attachments', authMiddleware, attachmentsController.list);

router.delete(
    '/:id/attachments/:attachmentId',
    authMiddleware,
    attachmentsController.delete,
);

// ── Create Proposal on a Request ───────────────────────────────────────────

router.post(
    '/:requestId/proposals',
    authMiddleware,
    validate(CreateProposalSchema, 'body'),
    requestsController.createProposal,
);

export default router;
