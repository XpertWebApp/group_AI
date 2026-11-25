import { Request, Response, NextFunction } from 'express';
import requestsService from '../services/requests.service';
import proposalsService from '../services/proposals.service';
import requestRepository from '../repositories/request.repository';
import { sendResponse } from '../utils/response';

export class RequestsController {
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const q = (req as any).validated?.query ?? req.query;
            const result = await requestsService.getAllRequests({
                page: q.page ? Number(q.page) : 1,
                limit: q.limit ? Math.min(Number(q.limit), 100) : 20,
                search: q.search as string | undefined,
                status: q.status as any,
                // Legacy params — kept for back-compat, filter `checkinDate`.
                dateFrom: q.dateFrom as string | undefined,
                dateTo: q.dateTo as string | undefined,
                // New explicit window on `createdAt` (dashboard "This Month/
                // Quarter/Year" filter chip).
                createdFrom: q.createdFrom as string | undefined,
                createdTo: q.createdTo as string | undefined,
                sortBy: (q.sortBy as any) ?? 'createdAt',
                sortOrder: (q.sortOrder as any) ?? 'desc',
            });
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

    /**
     * Explicit self-claim. 200 if claimed (or already owned by the same user),
     * 409 if another user already owns it.
     */
    async claim(req: Request, res: Response, next: NextFunction) {
        try {
            const requestId = req.params['id'] as string;
            const userId = (req as any).user?.id;
            if (!userId) {
                return sendResponse(res, 401, null, 'Unauthorized', 'UNAUTHORIZED');
            }
            const result = await requestsService.claimOwnershipIfUnassigned(
                requestId,
                userId,
                req.ip,
                'explicit',
            );
            if (!result.claimed && result.ownerId && result.ownerId !== userId) {
                const owner = await requestRepository.findOwner(requestId);
                return sendResponse(res, 409, { owner }, 'Request already assigned');
            }
            const owner = await requestRepository.findOwner(requestId);
            return sendResponse(
                res,
                200,
                { owner },
                result.claimed ? 'Claimed' : 'Already owned by you',
            );
        } catch (error) {
            next(error);
        }
    }
}

export default new RequestsController();
