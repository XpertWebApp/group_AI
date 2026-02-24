import { Request, Response, NextFunction } from 'express';
import requestsService from '../services/requests.service';
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
            const result = await requestsService.getRequestById(req.params.id as string);
            return sendResponse(res, 200, result, 'Request retrieved');
        } catch (error) {
            next(error);
        }
    }

    async updateStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await requestsService.updateRequestStatus(req.params.id as string, req.body.status);
            return sendResponse(res, 200, result, 'Request status updated');
        } catch (error) {
            next(error);
        }
    }
}

export default new RequestsController();
