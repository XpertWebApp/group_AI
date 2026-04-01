import { Router } from 'express';
import proposalsController from '../controllers/proposals.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
    UpdateProposalSchema,
    AddProposalHotelSchema,
    AdjustHotelPricingSchema,
    AddProposalServiceSchema,
    UpdateProposalServiceSchema,
    PreviewPdfSchema,
    SendProposalSchema,
    ApproveProposalSchema,
    DeclineProposalSchema,
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

router.get('/:id/pdf', authMiddleware, proposalsController.downloadPdf);

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

export default router;
