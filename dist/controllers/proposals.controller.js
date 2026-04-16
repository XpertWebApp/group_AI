"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProposalsController = void 0;
const proposals_service_1 = __importDefault(require("../services/proposals.service"));
const response_1 = require("../utils/response");
class ProposalsController {
    async list(req, res, next) {
        try {
            const result = await proposals_service_1.default.getAllProposals();
            return (0, response_1.sendResponse)(res, 200, result, 'Proposals retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async get(req, res, next) {
        try {
            const result = await proposals_service_1.default.getProposalById(req.params['id']);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async create(req, res, next) {
        try {
            const result = await proposals_service_1.default.createProposal(req.body);
            return (0, response_1.sendResponse)(res, 201, result, 'Proposal created successfully');
        }
        catch (error) {
            next(error);
        }
    }
    async updateMetadata(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const result = await proposals_service_1.default.updateMetadata(req.params['id'], body, userId);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal updated');
        }
        catch (error) {
            next(error);
        }
    }
    async addHotel(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const ip = req.ip;
            const result = await proposals_service_1.default.addHotelToProposal(req.params['id'], body, userId, ip);
            return (0, response_1.sendResponse)(res, 201, result, 'Hotel added to proposal');
        }
        catch (error) {
            next(error);
        }
    }
    async removeHotel(req, res, next) {
        try {
            const userId = req.user?.id;
            const result = await proposals_service_1.default.removeHotelFromProposal(req.params['id'], req.params['hotelId'], userId);
            return (0, response_1.sendResponse)(res, 200, result, 'Hotel removed from proposal');
        }
        catch (error) {
            next(error);
        }
    }
    async listHotels(req, res, next) {
        try {
            const result = await proposals_service_1.default.listHotels(req.params['id']);
            return (0, response_1.sendResponse)(res, 200, result, 'Hotels retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async adjustHotelPricing(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const result = await proposals_service_1.default.adjustHotelPricing(req.params['id'], req.params['hotelId'], body, userId);
            return (0, response_1.sendResponse)(res, 200, result, 'Hotel pricing updated');
        }
        catch (error) {
            next(error);
        }
    }
    async toggleHotelIncluded(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const ip = req.ip;
            const result = await proposals_service_1.default.toggleHotelIncluded(req.params['id'], req.params['hotelId'], body.includedInTotal, userId, ip);
            return (0, response_1.sendResponse)(res, 200, result, 'Hotel inclusion updated');
        }
        catch (error) {
            next(error);
        }
    }
    async addService(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const ip = req.ip;
            const result = await proposals_service_1.default.addServiceToProposal(req.params['id'], body, userId, ip);
            return (0, response_1.sendResponse)(res, 201, result, 'Service added to proposal');
        }
        catch (error) {
            next(error);
        }
    }
    async updateService(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            const ip = req.ip;
            const result = await proposals_service_1.default.updateServiceInProposal(req.params['id'], req.params['serviceId'], body, userId, ip);
            return (0, response_1.sendResponse)(res, 200, result, 'Service updated');
        }
        catch (error) {
            next(error);
        }
    }
    async removeService(req, res, next) {
        try {
            const userId = req.user?.id;
            const ip = req.ip;
            await proposals_service_1.default.removeServiceFromProposal(req.params['id'], req.params['serviceId'], userId, ip);
            return res.status(204).send();
        }
        catch (error) {
            next(error);
        }
    }
    async lock(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return (0, response_1.sendResponse)(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const ip = req.ip;
            const result = await proposals_service_1.default.lockProposal(req.params['id'], userId, ip);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal locked');
        }
        catch (error) {
            if (error.code === 'PROPOSAL_LOCKED') {
                return res.status(409).json({
                    error: { code: error.code, message: error.message, owner: error.owner },
                });
            }
            next(error);
        }
    }
    async unlock(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return (0, response_1.sendResponse)(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const result = await proposals_service_1.default.unlockProposal(req.params['id'], userId);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal unlocked');
        }
        catch (error) {
            next(error);
        }
    }
    async saveDraft(req, res, next) {
        try {
            const userId = req.user?.id;
            const result = await proposals_service_1.default.saveDraft(req.params['id'], userId);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal saved as draft');
        }
        catch (error) {
            next(error);
        }
    }
    async send(req, res, next) {
        try {
            const body = req.validated?.body ?? req.body;
            const userId = req.user?.id;
            if (!userId)
                return (0, response_1.sendResponse)(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const ip = req.ip;
            const result = await proposals_service_1.default.sendProposal(req.params['id'], body, userId, ip);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal sent');
        }
        catch (error) {
            if (error.code === 'PROPOSAL_LOCKED') {
                return res.status(409).json({
                    error: { code: error.code, message: error.message, owner: error.owner },
                });
            }
            // Email send failures from sendProposal — these now carry a structured `failure` object
            // with a specific code (NOT_CONNECTED, GMAIL_FORBIDDEN, etc.) and a per-failure HTTP status.
            if (error.code === 'EMAIL_SEND_FAILED' && error.failure) {
                return res.status(error.status ?? 502).json({
                    success: false,
                    data: error.data, // backward-compat: { sent, emailSent, emailError, emailErrorCode, proposal }
                    message: error.message,
                    error: 'EMAIL_SEND_FAILED',
                    failure: error.failure, // NEW: { code, message, retryable, userActionRequired, method }
                });
            }
            if (error.code === 'NO_RECIPIENT_EMAIL' || error.code === 'PDF_GENERATION_FAILED') {
                return res.status(error.status ?? 400).json({
                    success: false,
                    data: null,
                    message: error.message,
                    error: error.code,
                });
            }
            next(error);
        }
    }
    async previewPdf(req, res, next) {
        try {
            const result = await proposals_service_1.default.previewPdf(req.params['id']);
            if (result.pdfBuffer) {
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', 'inline; filename="offer-preview.pdf"');
                return res.send(result.pdfBuffer);
            }
            return (0, response_1.sendResponse)(res, 200, { previewUrl: null }, 'PDF preview not available');
        }
        catch (error) {
            next(error);
        }
    }
    /** GET /:id/offers — list offer history for a proposal */
    async listOffers(req, res, next) {
        try {
            const offers = await proposals_service_1.default.listOffers(req.params['id']);
            return (0, response_1.sendResponse)(res, 200, { offers, count: offers.length }, 'Offer history retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /** GET /:id/offers/:offerId/pdf — download the PDF for a specific offer */
    async downloadOfferPdf(req, res, next) {
        try {
            const proposalId = req.params['id'];
            const offerId = req.params['offerId'];
            const { pdfBuffer, filename } = await proposals_service_1.default.downloadOfferPdf(proposalId, offerId);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(pdfBuffer);
        }
        catch (error) {
            next(error);
        }
    }
    async approve(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return (0, response_1.sendResponse)(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const body = req.validated?.body ?? req.body;
            const ip = req.ip;
            const result = await proposals_service_1.default.approveProposal(req.params['id'], { agentEmail: body.agentEmail, adminNotes: body.adminNotes }, userId, ip);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal approved');
        }
        catch (error) {
            if (error.code === 'PROPOSAL_NOT_APPROVABLE') {
                return res.status(409).json({ error: { code: error.code, message: error.message } });
            }
            next(error);
        }
    }
    async decline(req, res, next) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return (0, response_1.sendResponse)(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const body = req.validated?.body ?? req.body;
            const ip = req.ip;
            const result = await proposals_service_1.default.declineProposal(req.params['id'], { rejectionReason: body.rejectionReason }, userId, ip);
            return (0, response_1.sendResponse)(res, 200, result, 'Proposal declined');
        }
        catch (error) {
            if (error.code === 'PROPOSAL_NOT_APPROVABLE' ||
                error.code === 'PROPOSAL_NOT_DECLINABLE' ||
                error.code === 'REJECTION_REASON_REQUIRED') {
                return res.status(error.status ?? 409).json({ error: { code: error.code, message: error.message } });
            }
            next(error);
        }
    }
}
exports.ProposalsController = ProposalsController;
exports.default = new ProposalsController();
