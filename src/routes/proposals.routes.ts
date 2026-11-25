import { Router } from 'express';
import proposalsController from '../controllers/proposals.controller';
import optionSelectionController from '../controllers/optionSelection.controller';
import { RecordSelectionSchema } from '../validation/optionSelectionSchemas';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    UpdateProposalSchema,
    AddProposalHotelSchema,
    AdjustHotelPricingSchema,
    ToggleProposalHotelSchema,
    AddProposalServiceSchema,
    UpdateProposalServiceSchema,
    PreviewPdfSchema,
    SendProposalSchema,
    ApproveProposalSchema,
    DeclineProposalSchema,
    DownloadPdfQuerySchema,
    UpdateProposalHotelCancellationSchema,
    UpdateProposalPaymentDeadlineSchema,
} from '../validation/requestSchemas';
import rateLimit from 'express-rate-limit';

const router = Router();

const addHotelLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

// Proposal CRUD
router.get('/', authMiddleware, proposalsController.list);
router.get('/:id', authMiddleware, proposalsController.get);

router.patch(
    '/:id',
    authMiddleware,
    validate(UpdateProposalSchema, 'body'),
    proposalsController.updateMetadata,
);

// Hotels on proposal
router.post(
    '/:id/hotels',
    authMiddleware,
    addHotelLimiter,
    validate(AddProposalHotelSchema, 'body'),
    proposalsController.addHotel,
);

router.delete('/:id/hotels/:hotelId', authMiddleware, proposalsController.removeHotel);

router.get('/:id/hotels', authMiddleware, proposalsController.listHotels);

router.post(
    '/:id/hotels/:hotelId/adjust-pricing',
    authMiddleware,
    validate(AdjustHotelPricingSchema, 'body'),
    proposalsController.adjustHotelPricing,
);

router.patch(
    '/:id/hotels/:hotelId',
    authMiddleware,
    validate(ToggleProposalHotelSchema, 'body'),
    proposalsController.toggleHotelIncluded,
);

// PATCH the cancellation-deadline override on a single proposal hotel.
// Pass `{ cancelDeadlineOverride: null }` in the body to clear back to the
// supplier's date. Application-layer guard rejects overrides later than the
// supplier's actual deadline (would expose SETT to the cancellation penalty).
router.patch(
    '/:id/hotels/:hotelId/cancellation',
    authMiddleware,
    validate(UpdateProposalHotelCancellationSchema, 'body'),
    proposalsController.updateHotelCancellation,
);

// PATCH the customer payment deadline on a proposal (single date for the
// whole proposal). Pass `{ paymentDeadline: null }` to clear, which marks
// the proposal unsendable. Application-layer guard rejects past dates and
// any date on/after the earliest hotel cancellation deadline.
router.patch(
    '/:id/payment-deadline',
    authMiddleware,
    validate(UpdateProposalPaymentDeadlineSchema, 'body'),
    proposalsController.updatePaymentDeadline,
);

// Services on proposal
router.post(
    '/:id/services',
    authMiddleware,
    validate(AddProposalServiceSchema, 'body'),
    proposalsController.addService,
);

router.patch(
    '/:id/services/:serviceId',
    authMiddleware,
    validate(UpdateProposalServiceSchema, 'body'),
    proposalsController.updateService,
);

router.delete('/:id/services/:serviceId', authMiddleware, proposalsController.removeService);

// Actions
router.post('/:id/actions/lock', authMiddleware, proposalsController.lock);
router.post('/:id/actions/unlock', authMiddleware, proposalsController.unlock);
router.post('/:id/actions/save-draft', authMiddleware, proposalsController.saveDraft);

router.post(
    '/:id/actions/send',
    authMiddleware,
    validate(SendProposalSchema, 'body'),
    proposalsController.send,
);

router.post(
    '/:id/actions/preview-pdf',
    authMiddleware,
    validate(PreviewPdfSchema, 'body'),
    proposalsController.previewPdf,
);

router.get(
    '/:id/pdf',
    authMiddleware,
    validate(DownloadPdfQuerySchema, 'query'),
    proposalsController.downloadPdf,
);

router.post(
    '/:id/actions/approve',
    authMiddleware,
    validate(ApproveProposalSchema, 'body'),
    proposalsController.approve,
);

router.post(
    '/:id/actions/decline',
    authMiddleware,
    validate(DeclineProposalSchema, 'body'),
    proposalsController.decline,
);

// Offer history (initial / final / revisions)
router.get('/:id/offers', authMiddleware, proposalsController.listOffers);
router.get(
    '/:id/offers/:offerId/pdf',
    authMiddleware,
    validate(DownloadPdfQuerySchema, 'query'),
    proposalsController.downloadOfferPdf,
);

// ── Option selection ────────────────────────────────────────────────────────
// The customer normally chooses through their own link; these are the staff
// equivalents, for reading the choice and for recording one made by phone.

router.get('/:id/selection', authMiddleware, optionSelectionController.getForProposal);

router.post(
    '/:id/selection',
    authMiddleware,
    validate(RecordSelectionSchema, 'body'),
    optionSelectionController.recordForCustomer,
);

export default router;
