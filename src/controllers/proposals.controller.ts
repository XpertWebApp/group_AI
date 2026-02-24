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
            const result = await proposalsService.getProposalById(req.params.id as string);
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

    async addHotel(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await proposalsService.addHotelToProposal(req.params.id as string, req.body);
            return sendResponse(res, 201, result, 'Hotel added to proposal');
        } catch (error) {
            next(error);
        }
    }

    async addService(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await proposalsService.addServiceToProposal(req.params.id as string, req.body);
            return sendResponse(res, 201, result, 'Service added to proposal');
        } catch (error) {
            next(error);
        }
    }
}

export default new ProposalsController();
