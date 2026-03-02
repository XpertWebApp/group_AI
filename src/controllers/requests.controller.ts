import { Request, Response, NextFunction } from 'express';
import requestsService from '../services/requests.service';
import proposalsService from '../services/proposals.service';
import { sendResponse } from '../utils/response';

export class RequestsController {
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await requestsService.getAllRequests();
            return sendResponse(res, 200, result, 'Requests retrieved');
        } catch (error) {
            next(error);
        }
    }

    async get(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await requestsService.getRequestById(req.params['id'] as string);
            return sendResponse(res, 200, result, 'Request retrieved');
        } catch (error) {
            next(error);
        }
    }

    async getSummary(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await requestsService.getSummary(req.params['id'] as string);
            return sendResponse(res, 200, result, 'Request summary retrieved');
        } catch (error) {
            next(error);
        }
    }

    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const ip = req.ip;
            const result = await requestsService.createRequest(body, userId, ip);
            res.setHeader('Location', `/api/v1/requests/${result.id}`);
            return sendResponse(res, 201, result, 'Booking request created');
        } catch (error) {
            next(error);
        }
    }

    async update(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const result = await requestsService.updateRequest(req.params['id'] as string, body, userId);
            return sendResponse(res, 200, result, 'Booking request updated');
        } catch (error) {
            next(error);
        }
    }

    async updateStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await requestsService.updateRequestStatus(req.params['id'] as string, req.body.status);
            return sendResponse(res, 200, result, 'Request status updated');
        } catch (error) {
            next(error);
        }
    }

    async createProposal(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const userId = (req as any).user?.id;
            const ip = req.ip;
            const result = await proposalsService.createForRequest(req.params['requestId'] as string, body, userId, ip);
            res.setHeader('Location', `/api/v1/proposals/${result.id}`);
            return sendResponse(res, 201, result, 'Proposal created');
        } catch (error) {
            next(error);
        }
    }
}

export default new RequestsController();
