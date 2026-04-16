"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const proposals_controller_1 = __importDefault(require("../controllers/proposals.controller"));
const auth_middleware_1 = require("../middlewares/auth.middleware");
const validate_middleware_1 = require("../middlewares/validate.middleware");
const requestSchemas_1 = require("../validation/requestSchemas");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const router = (0, express_1.Router)();
const addHotelLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});
// Proposal CRUD
router.get('/', auth_middleware_1.authMiddleware, proposals_controller_1.default.list);
router.get('/:id', auth_middleware_1.authMiddleware, proposals_controller_1.default.get);
router.patch('/:id', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.UpdateProposalSchema, 'body'), proposals_controller_1.default.updateMetadata);
// Hotels on proposal
router.post('/:id/hotels', auth_middleware_1.authMiddleware, addHotelLimiter, (0, validate_middleware_1.validate)(requestSchemas_1.AddProposalHotelSchema, 'body'), proposals_controller_1.default.addHotel);
router.delete('/:id/hotels/:hotelId', auth_middleware_1.authMiddleware, proposals_controller_1.default.removeHotel);
router.get('/:id/hotels', auth_middleware_1.authMiddleware, proposals_controller_1.default.listHotels);
router.post('/:id/hotels/:hotelId/adjust-pricing', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.AdjustHotelPricingSchema, 'body'), proposals_controller_1.default.adjustHotelPricing);
router.patch('/:id/hotels/:hotelId', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.ToggleProposalHotelSchema, 'body'), proposals_controller_1.default.toggleHotelIncluded);
// Services on proposal
router.post('/:id/services', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.AddProposalServiceSchema, 'body'), proposals_controller_1.default.addService);
router.patch('/:id/services/:serviceId', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.UpdateProposalServiceSchema, 'body'), proposals_controller_1.default.updateService);
router.delete('/:id/services/:serviceId', auth_middleware_1.authMiddleware, proposals_controller_1.default.removeService);
// Actions
router.post('/:id/actions/lock', auth_middleware_1.authMiddleware, proposals_controller_1.default.lock);
router.post('/:id/actions/unlock', auth_middleware_1.authMiddleware, proposals_controller_1.default.unlock);
router.post('/:id/actions/save-draft', auth_middleware_1.authMiddleware, proposals_controller_1.default.saveDraft);
router.post('/:id/actions/send', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.SendProposalSchema, 'body'), proposals_controller_1.default.send);
router.post('/:id/actions/preview-pdf', auth_middleware_1.authMiddleware, proposals_controller_1.default.previewPdf);
router.post('/:id/actions/approve', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.ApproveProposalSchema, 'body'), proposals_controller_1.default.approve);
router.post('/:id/actions/decline', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(requestSchemas_1.DeclineProposalSchema, 'body'), proposals_controller_1.default.decline);
// Offer history (initial / final / revisions)
router.get('/:id/offers', auth_middleware_1.authMiddleware, proposals_controller_1.default.listOffers);
router.get('/:id/offers/:offerId/pdf', auth_middleware_1.authMiddleware, proposals_controller_1.default.downloadOfferPdf);
exports.default = router;
