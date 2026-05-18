import { Request, Response, NextFunction } from 'express';
import proposalsService from '../services/proposals.service';
import { sendResponse } from '../utils/response';

export class ProposalsController {
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await proposalsService.getAllProposals();
            return sendResponse(res, 200, result, 'Proposals retrieved');
        } catch (error) {
            next(error);
        }
    }

    async get(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await proposalsService.getProposalById(req.params['id'] as string);
            return sendResponse(res, 200, result, 'Proposal retrieved');
        } catch (error) {
            next(error);
        }
    }

    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await proposalsService.createProposal(req.body);
            return sendResponse(res, 201, result, 'Proposal created successfully');
        } catch (error) {
            next(error);
        }
    }

    async updateMetadata(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const result = await proposalsService.updateMetadata(req.params['id'] as string, body, userId);
            return sendResponse(res, 200, result, 'Proposal updated');
        } catch (error) {
            next(error);
        }
    }

    async addHotel(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const ip = req.ip;
            const result = await proposalsService.addHotelToProposal(req.params['id'] as string, body, userId, ip);
            return sendResponse(res, 201, result, 'Hotel added to proposal');
        } catch (error) {
            next(error);
        }
    }

    async removeHotel(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user?.id;
            const result = await proposalsService.removeHotelFromProposal(
                req.params['id'] as string,
                req.params['hotelId'] as string,
                userId,
            );
            return sendResponse(res, 200, result, 'Hotel removed from proposal');
        } catch (error) {
            next(error);
        }
    }

    async listHotels(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await proposalsService.listHotels(req.params['id'] as string);
            return sendResponse(res, 200, result, 'Hotels retrieved');
        } catch (error) {
            next(error);
        }
    }

    async adjustHotelPricing(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const result = await proposalsService.adjustHotelPricing(
                req.params['id'] as string,
                req.params['hotelId'] as string,
                body,
                userId,
            );
            return sendResponse(res, 200, result, 'Hotel pricing updated');
        } catch (error) {
            next(error);
        }
    }

    async toggleHotelIncluded(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const ip = req.ip;
            const result = await proposalsService.toggleHotelIncluded(
                req.params['id'] as string,
                req.params['hotelId'] as string,
                body.includedInTotal,
                userId,
                ip,
            );
            return sendResponse(res, 200, result, 'Hotel inclusion updated');
        } catch (error) {
            next(error);
        }
    }

    async addService(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const ip = req.ip;
            const result = await proposalsService.addServiceToProposal(req.params['id'] as string, body, userId, ip);
            return sendResponse(res, 201, result, 'Service added to proposal');
        } catch (error) {
            next(error);
        }
    }

    async updateService(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const ip = req.ip;
            const result = await proposalsService.updateServiceInProposal(
                req.params['id'] as string,
                req.params['serviceId'] as string,
                body,
                userId,
                ip,
            );
            return sendResponse(res, 200, result, 'Service updated');
        } catch (error) {
            next(error);
        }
    }

    async removeService(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user?.id;
            const ip = req.ip;
            await proposalsService.removeServiceFromProposal(
                req.params['id'] as string,
                req.params['serviceId'] as string,
                userId,
                ip,
            );
            return res.status(204).send();
        } catch (error) {
            next(error);
        }
    }

    async lock(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) return sendResponse(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const ip = req.ip;
            const result = await proposalsService.lockProposal(req.params['id'] as string, userId, ip);
            return sendResponse(res, 200, result, 'Proposal locked');
        } catch (error: any) {
            if (error.code === 'PROPOSAL_LOCKED') {
                return res.status(409).json({
                    error: { code: error.code, message: error.message, owner: error.owner },
                });
            }
            next(error);
        }
    }

    async unlock(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) return sendResponse(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const result = await proposalsService.unlockProposal(req.params['id'] as string, userId);
            return sendResponse(res, 200, result, 'Proposal unlocked');
        } catch (error) {
            next(error);
        }
    }

    async saveDraft(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user?.id;
            const result = await proposalsService.saveDraft(req.params['id'] as string, userId);
            return sendResponse(res, 200, result, 'Proposal saved as draft');
        } catch (error) {
            next(error);
        }
    }

    async send(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            if (!userId) return sendResponse(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const ip = req.ip;
            const result = await proposalsService.sendProposal(req.params['id'] as string, body, userId, ip);

            return sendResponse(res, 200, result, 'Proposal sent');
        } catch (error: any) {
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
                    data: error.data,           // backward-compat: { sent, emailSent, emailError, emailErrorCode, proposal }
                    message: error.message,
                    error: 'EMAIL_SEND_FAILED',
                    failure: error.failure,     // NEW: { code, message, retryable, userActionRequired, method }
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

    async previewPdf(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const result = await proposalsService.previewPdf(req.params['id'] as string, body.language);
            if (result.pdfBuffer) {
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', 'inline; filename="offer-preview.pdf"');
                return res.send(result.pdfBuffer);
            }
            return sendResponse(res, 200, { previewUrl: null }, 'PDF preview not available');
        } catch (error) {
            next(error);
        }
    }

    async downloadPdf(req: Request, res: Response, next: NextFunction) {
        try {
            const { pdfBuffer, filename } = await proposalsService.downloadPdf(req.params['id'] as string);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(pdfBuffer);
        } catch (error) {
            next(error);
        }
    }

    /** GET /:id/offers — list offer history for a proposal */
    async listOffers(req: Request, res: Response, next: NextFunction) {
        try {
            const offers = await proposalsService.listOffers(req.params['id'] as string);
            return sendResponse(res, 200, { offers, count: offers.length }, 'Offer history retrieved');
        } catch (error) {
            next(error);
        }
    }

    /** GET /:id/offers/:offerId/pdf — download the PDF for a specific offer */
    async downloadOfferPdf(req: Request, res: Response, next: NextFunction) {
        try {
            const proposalId = req.params['id'] as string;
            const offerId = req.params['offerId'] as string;
            const { pdfBuffer, filename } = await proposalsService.downloadOfferPdf(proposalId, offerId);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(pdfBuffer);
        } catch (error) {
            next(error);
        }
    }

    async approve(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) return sendResponse(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const body = (req as any).validated?.body ?? req.body;
            const ip = req.ip;
            const result = await proposalsService.approveProposal(
                req.params['id'] as string,
                { agentEmail: body.agentEmail, adminNotes: body.adminNotes, language: body.language },
                userId,
                ip,
            );
            return sendResponse(res, 200, result, 'Proposal approved');
        } catch (error: any) {
            if (error.code === 'PROPOSAL_NOT_APPROVABLE') {
                return res.status(409).json({ error: { code: error.code, message: error.message } });
            }
            next(error);
        }
    }

    async decline(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) return sendResponse(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            const body = (req as any).validated?.body ?? req.body;
            const ip = req.ip;
            const result = await proposalsService.declineProposal(
                req.params['id'] as string,
                { rejectionReason: body.rejectionReason },
                userId,
                ip,
            );
            return sendResponse(res, 200, result, 'Proposal declined');
        } catch (error: any) {
            if (
                error.code === 'PROPOSAL_NOT_APPROVABLE' ||
                error.code === 'PROPOSAL_NOT_DECLINABLE' ||
                error.code === 'REJECTION_REASON_REQUIRED'
            ) {
                return res.status(error.status ?? 409).json({ error: { code: error.code, message: error.message } });
            }
            next(error);
        }
    }
}

export default new ProposalsController();
