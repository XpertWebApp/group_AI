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
            next(error);
        }
    }

    async previewPdf(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await proposalsService.previewPdf(req.params['id'] as string);
            return sendResponse(res, 200, result, 'PDF preview placeholder');
        } catch (error) {
            next(error);
        }
    }
}

export default new ProposalsController();
